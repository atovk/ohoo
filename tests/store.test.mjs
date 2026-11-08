import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore, StoreError } from "../server/store.mjs";

const throwsStatus = (fn, status) =>
  assert.throws(
    fn,
    (error) => error instanceof StoreError && error.status === status,
  );
const agent = (id) => ({
  id: "draft",
  kind: "agent",
  name: "起草",
  assigneeId: id,
  duty: "整理需求",
  output: "需求稿",
  skills: ["需求整理"],
  clis: ["git"],
  environmentId: "local",
  provider: "codex",
  model: "default",
  cwd: "/tmp",
  requiredFields: ["验收样例"],
});
const person = (id, roleId = "sign") => ({
  id: roleId,
  kind: "human",
  name: "验收",
  assigneeId: id,
  duty: "核对稿件",
  output: "审阅稿",
});
const draft = (
  requestId,
  body = "导出有权限的订单",
  summary = "核对业务范围",
) => ({
  requestId,
  title: "订单范围初稿",
  body,
  summary,
  fields: { 验收样例: "43 条" },
});

function fixture(t, { file = ":memory:", third = false } = {}) {
  const s = createStore(file);
  t.after(() => s.close());
  const owner = s.owner();
  const member = (name) =>
    s.redeemInvite(s.createInvite(owner.id).token, { name });
  const reviewer = member("编辑"),
    observer = member("同组别的角色"),
    outsider = member("非团队成员");
  const roles = [agent(owner.id), person(reviewer.id)];
  if (third) roles.push(person(observer.id, "close"));
  const config = {
    name: "运营组",
    goal: "核对需求",
    memberIds: [owner.id, reviewer.id, observer.id],
    roles,
  };
  const team = s.createTeam(owner.id, config);
  const run = s.startRun(owner.id, team.id, { title: "导出范围" });
  return { s, owner, reviewer, observer, outsider, config, team, run };
}

test("single-use invitations create independent identities, with no default privileged member", (t) => {
  const s = createStore();
  t.after(() => s.close());
  const owner = s.owner();
  assert.deepEqual(s.listMembers(owner.id), [owner]);
  const invite = s.createInvite(owner.id);
  const member = s.redeemInvite(invite.token, { name: owner.name });
  assert.equal(member.role, "member");
  assert.notEqual(member.id, owner.id);
  assert.deepEqual(s.getUser(member.id), member);
  assert.equal(s.getUser("missing"), null);
  throwsStatus(() => s.redeemInvite(invite.token, { name: "再次使用" }), 410);
  throwsStatus(() => s.createInvite(member.id), 403);
  throwsStatus(() => s.listMembers("anonymous"), 401);
  throwsStatus(() => s.redeemInvite("bad-token", { name: "谁" }), 410);
});

test("team version is frozen for each run and current membership still controls access", (t) => {
  const { s, owner, reviewer, outsider, team, config, run } = fixture(t);
  const updated = {
    ...config,
    name: "第二版",
    roles: config.roles.map((r) => ({ ...r, output: "新版产物" })),
    expectedVersion: 1,
  };
  assert.equal(s.updateTeam(owner.id, team.id, updated).version, 2);
  throwsStatus(() => s.updateTeam(owner.id, team.id, updated), 409);
  const first = s.getRun(reviewer.id, run.id);
  const second = s.startRun(reviewer.id, team.id, { title: "新任务" });
  assert.equal(first.roles[0].output, "需求稿");
  assert.equal(first.teamVersion, 1);
  assert.equal(second.roles[0].output, "新版产物");
  assert.equal(second.teamVersion, 2);
  assert.deepEqual(s.listTeams(outsider.id), []);
  assert.deepEqual(s.listRuns(outsider.id), []);
  throwsStatus(() => s.getRun(outsider.id, run.id), 404);
  throwsStatus(() => s.createTeam(reviewer.id, config), 403);
  const removed = {
    ...config,
    memberIds: [owner.id],
    roles: [agent(owner.id), person(owner.id)],
  };
  s.updateTeam(owner.id, team.id, removed);
  throwsStatus(() => s.getRun(reviewer.id, run.id), 404);
  assert.equal(s.listRuns(reviewer.id).length, 0);
  assert.equal(s.getRun(owner.id, run.id).roles[1].assigneeId, reviewer.id);
});

test("team roles cannot bind other identities to the personal local agent", (t) => {
  const { s, owner, config, reviewer } = fixture(t);
  const create = (overrides) =>
    s.createTeam(owner.id, {
      ...config,
      roles: [{ ...config.roles[0], ...overrides }, config.roles[1]],
    });
  throwsStatus(() => create({ assigneeId: reviewer.id }), 400);
  throwsStatus(() => create({ environmentId: "another-host" }), 400);
  throwsStatus(() => create({ id: config.roles[1].id }), 400);
});

test("private turns are idempotent and mutually exclusive with handoff", (t) => {
  const { s, run, owner, reviewer, observer } = fixture(t);
  const call = (requestId, text) =>
    s.beginTurn(owner.id, run.id, "draft", { requestId, text });
  const session = s.getSession(owner.id, run.id, "draft");
  s.bindNativeSession(owner.id, run.id, "draft", "paseo-private-id");
  assert.equal(
    s.bindNativeSession(owner.id, run.id, "draft", "paseo-private-id").id,
    session.id,
  );
  throwsStatus(
    () => s.bindNativeSession(owner.id, run.id, "draft", "second-id"),
    409,
  );
  throwsStatus(() => s.getSession(reviewer.id, run.id, "draft"), 403);
  throwsStatus(() => s.getSession(observer.id, run.id, "draft"), 403);
  assert.equal(call("turn-a", "内部笔记").created, true);
  assert.equal(call("turn-a", "内部笔记").created, false);
  throwsStatus(() => call("turn-a", "另一笔记"), 409);
  throwsStatus(() => call("turn-b", "并发消息"), 409);
  throwsStatus(
    () => s.submitArtifact(owner.id, run.id, "draft", draft("post")),
    409,
  );
  assert.equal(s.listPendingTurns()[0].requestId, "turn-a");
  const done = s.finishTurn(owner.id, run.id, "draft", "turn-a", {
    text: "私人回答",
  });
  assert.deepEqual(
    done.messages.map((m) => m.text),
    ["内部笔记", "私人回答"],
  );
  s.finishTurn(owner.id, run.id, "draft", "turn-a", { text: "私人回答" });
  throwsStatus(
    () =>
      s.failTurn(owner.id, run.id, "draft", "turn-a", { error: "迟到的失败" }),
    409,
  );
  assert.equal(call("turn-a", "内部笔记").turn.status, "completed");
  assert.deepEqual(s.listPendingTurns(), []);
  const submitted = s.submitArtifact(owner.id, run.id, "draft", draft("post"));
  assert.equal(submitted.currentRoleId, "sign");
  throwsStatus(() => call("turn-b", "晚到消息"), 409);
  for (const data of [
    s.getRun(reviewer.id, run.id),
    s.listRuns(observer.id),
    s.getRun(owner.id, run.id),
  ]) {
    assert.doesNotMatch(
      JSON.stringify(data),
      /内部笔记|私人回答|paseo-private-id/,
    );
  }
});

test("private and shared text preserve meaningful indentation independently", (t) => {
  const { s, run, owner } = fixture(t);
  const privateText = "    private excerpt\n";
  s.beginTurn(owner.id, run.id, "draft", {
    requestId: "turn",
    text: privateText,
  });
  const session = s.finishTurn(owner.id, run.id, "draft", "turn", {
    text: "received",
  });
  assert.equal(session.messages[0].text, privateText);
  const body = "    selected excerpt\n";
  const next = s.submitArtifact(
    owner.id,
    run.id,
    "draft",
    draft("deliver", body),
  );
  assert.equal(next.artifacts[0].body, body);
  assert.doesNotMatch(JSON.stringify(next), /private excerpt/);
});

test("review is version-bound and retries never issue a second handoff", (t) => {
  const { s, owner, reviewer, observer, run } = fixture(t);
  const submit = (dto) => s.submitArtifact(owner.id, run.id, "draft", dto);
  const review = (dto, who = reviewer.id) => s.reviewArtifact(who, run.id, dto);
  throwsStatus(() => submit({ ...draft("submit-a"), fields: {} }), 400);
  assert.equal(s.getRun(owner.id, run.id).currentRoleId, "draft");
  const first = submit(draft("submit-a")).artifacts[0];
  assert.equal(submit(draft("submit-a")).artifacts.length, 1);
  throwsStatus(() => submit(draft("submit-a", "不同正文")), 409);
  const returned = {
    requestId: "return-a",
    artifactId: first.id,
    revision: 1,
    action: "return",
    feedback: "补权限样例",
  };
  throwsStatus(() => review(returned, observer.id), 403);
  throwsStatus(() => review({ ...returned, feedback: "" }), 400);
  assert.equal(review(returned).currentRoleId, "draft");
  assert.equal(review(returned).artifacts[0].feedback, "补权限样例");
  const second = submit(draft("submit-b", "第二版正文")).artifacts[1];
  assert.equal(first.id, second.id);
  assert.equal(second.revision, 2);
  const accept = {
    requestId: "accept-b",
    artifactId: first.id,
    revision: 2,
    action: "accept",
  };
  throwsStatus(() => review({ ...accept, revision: 1 }), 409);
  const done = review(accept);
  assert.equal(done.status, "completed");
  assert.deepEqual(
    done.history.map((h) => h.type),
    ["started", "submitted", "returned", "submitted", "accepted", "completed"],
  );
  assert.deepEqual(
    done.artifacts.map((a) => a.status),
    ["returned", "accepted"],
  );
  assert.deepEqual(review(accept), done);
});

test("multi-step deliveries protect explicit contents from nonparticipants, including the admin", (t) => {
  const { s, owner, reviewer, observer, run } = fixture(t, { third: true });
  const a = s.submitArtifact(owner.id, run.id, "draft", draft("step1"))
    .artifacts[0];
  throwsStatus(
    () => s.submitArtifact(reviewer.id, run.id, "sign", draft("step2")),
    409,
  );
  s.reviewArtifact(reviewer.id, run.id, {
    requestId: "accept1",
    artifactId: a.id,
    revision: 1,
    action: "accept",
  });
  const secondPrivate = {
    requestId: "step2",
    title: "私密标题",
    body: "私密正文",
    summary: "私密摘要",
    fields: { 明细: "私密字段" },
  };
  const b = s
    .submitArtifact(reviewer.id, run.id, "sign", secondPrivate)
    .artifacts.at(-1);
  assert.equal(b.canRead, true);
  const revealed = s.getRun(observer.id, run.id);
  assert.equal(revealed.artifacts[0].canRead, false);
  assert.equal(revealed.artifacts[1].summary, "私密摘要");
  assert.ok(!("body" in revealed.artifacts[0]));
  const decision = {
    requestId: "accept2",
    artifactId: b.id,
    revision: b.revision,
    action: "accept",
    feedback: "私密签收意见",
  };
  assert.equal(
    s.reviewArtifact(observer.id, run.id, decision).status,
    "completed",
  );
  const admin = s.getRun(owner.id, run.id);
  assert.equal(admin.artifacts[1].canRead, false);
  assert.equal(admin.artifacts[1].title, "审阅稿");
  assert.doesNotMatch(JSON.stringify(admin), /私密/);
});

test("restart and a competing store preserve pending turn identity, invite consumption and WAL data", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ohoo-store-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "ohoo.sqlite");
  const a = createStore(path);
  const o = a.owner(),
    token = a.createInvite(o.id).token;
  const db = new DatabaseSync(path, { readOnly: true });
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.notEqual(db.prepare("SELECT digest FROM invites").get().digest, token);
  db.close();
  const r = a.redeemInvite(token, { name: "接收人" });
  const team = a.createTeam(o.id, {
    name: "团队",
    memberIds: [r.id],
    roles: [agent(o.id), person(r.id)],
  });
  const run = a.startRun(o.id, team.id, { title: "重启恢复" });
  const session = a.bindNativeSession(o.id, run.id, "draft", "stable-native");
  a.beginTurn(o.id, run.id, "draft", { requestId: "pending", text: "待核对" });
  const b = createStore(path);
  t.after(() => b.close());
  assert.equal(
    b.beginTurn(o.id, run.id, "draft", { requestId: "pending", text: "待核对" })
      .created,
    false,
  );
  throwsStatus(
    () =>
      b.beginTurn(o.id, run.id, "draft", {
        requestId: "competing",
        text: "另一次",
      }),
    409,
  );
  a.close();
  assert.deepEqual(b.owner(), o);
  assert.equal(b.listPendingTurns()[0].sessionId, session.id);
  assert.equal(
    b.getSession(o.id, run.id, "draft").nativeSessionId,
    "stable-native",
  );
  throwsStatus(() => b.redeemInvite(token, { name: "重放" }), 410);
  const completed = b.failTurn(o.id, run.id, "draft", "pending", {
    error: "经核对未完成",
  });
  assert.equal(completed.turns[0].status, "failed");
  assert.deepEqual(b.listPendingTurns(), []);
});

function deliverJob(s, job, { fail = false } = {}) {
  const work = s.claimHandoff(job.id);
  assert.equal(work.job.status, "prepared");
  assert.equal(work.turn.handoffStatus, "prepared");
  assert.equal(s.claimHandoff(job.id), null);
  assert.equal(s.markHandoffDispatched(job.id), true);
  assert.equal(s.markHandoffDispatched(job.id), false);
  if (fail)
    s.failTurn(job.assigneeId, job.runId, job.roleId, job.requestId, {
      error: "执行失败，交还成员",
    });
  else
    s.finishTurn(job.assigneeId, job.runId, job.roleId, job.requestId, {
      text: "私有执行结果",
    });
  return work.session.id;
}

test("edited designs, approval, implementation rework and final acceptance are bound to exact revisions", (t) => {
  const { s, owner, reviewer, observer } = fixture(t);
  const req = agent(owner.id),
    dev = { ...agent(owner.id), id: "dev", autoStartOnHandoff: true };
  const lead = { ...person(reviewer.id), reviewMode: "design" };
  const team = s.createTeam(owner.id, {
    name: "交付",
    roles: [req, dev, lead],
    memberIds: [reviewer.id, observer.id],
  });
  const run = s.startRun(owner.id, team.id, { title: "导出" }).id;
  const submit = (role, request, body) =>
    s.submitArtifact(owner.id, run, role, draft(request, body));
  const review = (actor, a, action, other = {}) =>
    s.reviewArtifact(actor, run, {
      requestId: action + "-" + a.id + "-" + a.revision,
      artifactId: a.id,
      revision: a.revision,
      action,
      ...other,
    });
  const upstream = submit(req.id, "requirement", "只导出可访问的订单。")
    .artifacts[0];
  assert.equal(upstream.status, "accepted");
  submit(req.id, "requirement", "只导出可访问的订单。");
  const [first] = s.listQueuedHandoffs();
  assert.equal(s.listQueuedHandoffs().length, 1);
  assert.deepEqual(first.inputArtifacts, [
    { artifactId: upstream.id, revision: 1 },
  ]);
  throwsStatus(() => submit(dev.id, "too-early", "v1"), 409);
  const privateId = deliverJob(s, first);
  const v1 = submit(dev.id, "proposed", "拟实现权限判断。").artifacts.at(-1);
  throwsStatus(() => review(owner.id, v1, "edit", { body: "伪造审核" }), 403);
  throwsStatus(() => review(reviewer.id, v1, "accept"), 409);
  const edit = review(reviewer.id, v1, "edit", { body: "复用订单权限过滤。" });
  const v2 = edit.artifacts.at(-1);
  assert.equal(v2.id, v1.id);
  assert.equal(v2.revision, 2);
  assert.equal(v2.editedBy, reviewer.id);
  assert.equal(v2.submittedBy, owner.id);
  assert.equal(v2.supersedesRevision, 1);
  assert.equal(
    edit.artifacts.find((a) => a.id === v1.id && a.revision === 1).status,
    "superseded",
  );
  assert.deepEqual(
    review(reviewer.id, v1, "edit", { body: "复用订单权限过滤。" }),
    edit,
  );
  throwsStatus(() => review(reviewer.id, v1, "confirm_start"), 409);
  throwsStatus(() => review(reviewer.id, v2, "return"), 400);
  const returned = review(reviewer.id, v2, "return", {
    feedback: "补齐跨页用例。",
  });
  const revisionJob = returned.handoffJobs.at(-1);
  assert.equal(revisionJob.trigger, "return");
  assert.deepEqual(revisionJob.inputArtifacts, [
    { artifactId: upstream.id, revision: 1 },
    { artifactId: v2.id, revision: 2 },
  ]);
  assert.equal(deliverJob(s, revisionJob, { fail: true }), privateId);
  const v3 = submit(dev.id, "revised", "权限过滤 + 跨页回归。").artifacts.at(
    -1,
  );
  assert.equal(v3.revision, 3);
  assert.equal(v3.editedBy, null);
  const confirmed = review(reviewer.id, v3, "confirm_start");
  assert.equal(confirmed.currentRoleId, dev.id);
  assert.equal(confirmed.phase, "implementation");
  assert.equal(confirmed.approvedDesign.artifactId, v3.id);
  assert.equal(confirmed.approvedDesign.revision, 3);
  assert.equal(confirmed.approvedDesign.approvedBy, reviewer.id);
  assert.equal(confirmed.approvedDesign.roleId, dev.id);
  assert.equal(confirmed.handoffJobs.at(-1).trigger, "confirm_start");
  assert.deepEqual(review(reviewer.id, v3, "confirm_start"), confirmed);
  assert.equal(deliverJob(s, confirmed.handoffJobs.at(-1)), privateId);
  const impl = submit(dev.id, "implement", "已实现分页。").artifacts.at(-1);
  assert.notEqual(impl.id, v3.id);
  assert.equal(impl.revision, 1);
  assert.equal(impl.phase, "implementation");
  throwsStatus(() => review(reviewer.id, impl, "confirm_start"), 409);
  throwsStatus(
    () => review(reviewer.id, impl, "edit", { body: "跳过复验" }),
    409,
  );
  const fix = review(reviewer.id, impl, "return", {
    feedback: "补测试证据。",
  }).handoffJobs.at(-1);
  assert.equal(fix.phase, "implementation");
  assert.deepEqual(fix.inputArtifacts, [
    { artifactId: upstream.id, revision: 1 },
    { artifactId: v3.id, revision: 3 },
    { artifactId: impl.id, revision: 1 },
  ]);
  deliverJob(s, fix);
  const implV2 = submit(dev.id, "fixed", "已通过分页回归测试。").artifacts.at(
    -1,
  );
  assert.equal(implV2.id, impl.id);
  assert.equal(implV2.revision, 2);
  const done = review(reviewer.id, implV2, "accept");
  assert.equal(done.status, "completed");
  assert.equal(
    done.history.filter((event) => event.type === "confirm_start").length,
    1,
  );
  assert.equal(done.handoffJobs.length, 4);
  assert.doesNotMatch(
    JSON.stringify(s.getRun(observer.id, run)),
    /权限过滤 \+ 跨页回归|私有执行结果|补测试证据/,
  );
});

test("prepared work survives restart and only one service can enter dispatch", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ohoo-prepared-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  const a = createStore(path),
    owner = a.owner();
  const team = a.createTeam(owner.id, {
    name: "两位 agent",
    memberIds: [],
    roles: [
      agent(owner.id),
      { ...agent(owner.id), id: "final", autoStartOnHandoff: true },
    ],
  });
  const run = a.startRun(owner.id, team.id, { title: "交托角色" }).id;
  const submitted = a.submitArtifact(owner.id, run, "draft", draft("one"));
  const task = submitted.handoffJobs[0];
  assert.equal(submitted.artifacts[0].status, "pending");
  const prepared = a.claimHandoff(task.id);
  assert.equal(prepared.session.turns.length, 1);
  assert.deepEqual(a.listQueuedHandoffs(), []);
  a.close();
  const b = createStore(path),
    c = createStore(path);
  t.after(() => {
    b.close();
    c.close();
  });
  const recovered = b.listPreparedHandoffs();
  assert.equal(recovered[0].session.id, prepared.session.id);
  assert.equal(recovered[0].turn.requestId, prepared.turn.requestId);
  assert.equal(c.claimHandoff(task.id), null);
  assert.equal(b.markHandoffDispatched(task.id), true);
  assert.equal(c.markHandoffDispatched(task.id), false);
  assert.deepEqual(c.listPreparedHandoffs(), []);
  assert.equal(c.listPendingTurns()[0].handoffStatus, "running");
  b.finishTurn(owner.id, run, "final", task.requestId, { text: "已核对" });
  const done = c.reviewArtifact(owner.id, run, {
    requestId: "sign",
    artifactId: submitted.artifacts[0].id,
    revision: 1,
    action: "accept",
  });
  assert.equal(done.status, "completed");
  assert.equal(done.handoffJobs[0].status, "completed");
});

test("design mode requires a preceding agent; explicit implementation start also works without auto-intake", (t) => {
  const { s, owner, reviewer } = fixture(t);
  const dev = agent(owner.id),
    lead = { ...person(reviewer.id), reviewMode: "design" };
  const create = (roles) =>
    s.createTeam(owner.id, { name: "评审", memberIds: [reviewer.id], roles });
  throwsStatus(() => create([lead, dev]), 400);
  throwsStatus(() => create([person(owner.id, "another"), lead]), 400);
  throwsStatus(() => create([dev, { ...lead, autoStartOnHandoff: true }]), 400);
  const team = create([dev, lead, person(reviewer.id, "after")]);
  const run = s.startRun(owner.id, team.id, { title: "非末节点评审" }).id;
  const design = s.submitArtifact(owner.id, run, dev.id, draft("design"))
    .artifacts[0];
  const approved = s.reviewArtifact(reviewer.id, run, {
    requestId: "go",
    artifactId: design.id,
    revision: 1,
    action: "confirm_start",
  });
  assert.equal(approved.handoffJobs.length, 1);
  deliverJob(s, approved.handoffJobs[0]);
  const implementation = s
    .submitArtifact(owner.id, run, dev.id, {
      requestId: "implementation",
      body: "已实施",
      summary: "请验收",
    })
    .artifacts.at(-1);
  assert.equal(implementation.title, "实现产物");
  const continued = s.reviewArtifact(reviewer.id, run, {
    requestId: "ok",
    artifactId: implementation.id,
    revision: 1,
    action: "accept",
  });
  assert.equal(continued.phase, "handoff");
  assert.equal(continued.currentRoleId, lead.id);
  assert.equal(continued.approvedDesign.artifactId, design.id);
  const handoff = s
    .submitArtifact(reviewer.id, run, lead.id, {
      requestId: "next",
      body: "总结",
      summary: "签收",
    })
    .artifacts.at(-1);
  const done = s.reviewArtifact(reviewer.id, run, {
    requestId: "done",
    artifactId: handoff.id,
    revision: 1,
    action: "accept",
  });
  assert.equal(done.status, "completed");
  assert.equal(done.handoffJobs.length, 1);
});

test("legacy pending artifacts and frozen roles survive a transactional upgrade", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ohoo-legacy-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite"),
    old = new DatabaseSync(path);
  old.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE teams(id TEXT PRIMARY KEY,name TEXT,goal TEXT,version INTEGER,roles_json TEXT,created_at TEXT);
    CREATE TABLE team_members(team_id TEXT,user_id TEXT,PRIMARY KEY(team_id,user_id));
    CREATE TABLE runs(id TEXT PRIMARY KEY,team_id TEXT,team_name TEXT,team_version INTEGER,roles_json TEXT,title TEXT,
      current_role_id TEXT,status TEXT,created_by TEXT,created_at TEXT);
    CREATE TABLE run_members(run_id TEXT,user_id TEXT,PRIMARY KEY(run_id,user_id));
    CREATE TABLE artifacts(id TEXT,revision INTEGER,run_id TEXT,from_role_id TEXT,to_role_id TEXT,title TEXT,body TEXT,
      summary TEXT,fields_json TEXT,submitted_by TEXT,created_at TEXT,status TEXT CHECK(status in ('pending','accepted','returned')),
      feedback TEXT,reviewed_by TEXT,reviewed_at TEXT,PRIMARY KEY(id,revision),UNIQUE(run_id,from_role_id,revision));
    INSERT INTO users VALUES('o','所有者','owner','then'),('m','评审','member','then');
    INSERT INTO team_members VALUES('t','o'),('t','m'); INSERT INTO run_members VALUES('r','o'),('r','m');
    INSERT INTO artifacts VALUES('a',1,'r','draft','sign','旧稿','原文','旧交接','{}','o','then','pending',NULL,NULL,NULL);`);
  const legacy = JSON.stringify([agent("o"), person("m")]);
  old
    .prepare("INSERT INTO teams VALUES('t','旧团队','',1,?,'then')")
    .run(legacy);
  old
    .prepare(
      "INSERT INTO runs VALUES('r','t','旧团队',1,?,'旧运行','sign','active','o','then')",
    )
    .run(legacy);
  old.close();
  const migrated = createStore(path);
  t.after(() => migrated.close());
  const before = migrated.getRun("m", "r");
  assert.equal(before.phase, "handoff");
  assert.equal(before.approvedDesign, null);
  assert.equal(before.roles[0].autoStartOnHandoff, false);
  assert.equal(before.roles[1].reviewMode, "standard");
  assert.equal(before.artifacts[0].body, "原文");
  assert.equal(before.artifacts[0].phase, "handoff");
  assert.deepEqual(before.handoffJobs, []);
  const done = migrated.reviewArtifact("m", "r", {
    requestId: "sign",
    artifactId: "a",
    revision: 1,
    action: "accept",
  });
  assert.equal(done.status, "completed");
});
