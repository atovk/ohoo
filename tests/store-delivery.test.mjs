import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore, StoreError } from "../server/store.mjs";

const candidate = (version) => ({
  digest: String(version).repeat(64),
  files: ["app.js"],
});
const payload = (key = "impl") => ({
  requestId: key,
  title: "实现结果",
  body: "已提交本次代码变更。",
  summary: "请运行测试。",
});
const fail = (fn, status) =>
  assert.throws(fn, (e) => e instanceof StoreError && e.status === status);

function fixture(
  t,
  { maxRepairs = 2, devAuto = true, file = ":memory:" } = {},
) {
  const s = createStore(file);
  t.after(() => s.close());
  const user = s.owner();
  const reader = s.redeemInvite(s.createInvite(user.id).token, {
    name: "同组其他成员",
  });
  const role = (id, delivery) => ({
    id,
    name: id,
    kind: "agent",
    assigneeId: user.id,
    duty: "执行 " + id,
    output: id + "报告",
    autoStartOnHandoff: id !== "dev" || devAuto,
    environmentId: "local",
    provider: "codex",
    cwd: "/tmp",
    delivery,
  });
  const roles = [
    role("dev"),
    role("qa", {
      kind: "qa",
      files: ["app.js"],
      test: ["node", "check.js"],
      maxRepairs,
    }),
    role("sre", {
      kind: "release",
      target: "test",
      deploy: ["node", "deploy.js"],
      verify: ["node", "verify.js"],
    }),
  ];
  const team = s.createTeam(user.id, {
    name: "交付团队",
    memberIds: [reader.id],
    roles,
  });
  const run = s.startRun(user.id, team.id, { title: "订单修复" });
  return { s, owner: user.id, reader: reader.id, roles, run: run.id };
}
function start(s, roleId) {
  const job = s.listQueuedHandoffs().find((j) => j.roleId === roleId);
  assert.ok(job);
  const work = s.claimHandoff(job.id);
  s.bindNativeSession(
    job.assigneeId,
    job.runId,
    job.roleId,
    "native-" + roleId,
  );
  assert.equal(s.markHandoffDispatched(job.id), true);
  return { ...work.job, status: "running" };
}
function end(s, job, text = "QA 或 SRE 的私有模型回复") {
  s.finishTurn(job.assigneeId, job.runId, job.roleId, job.requestId, { text });
}
function execute(s, job, op, exitCode = 0, output = "测试输出") {
  const permit = s.beginDeliveryAction(job.id, op);
  assert.equal(permit.created, true);
  const result = s.finishDeliveryAction(permit.action.id, { exitCode, output });
  assert.equal(result.id, permit.action.id);
  assert.equal(result.status, exitCode === 0 ? "succeeded" : "failed");
  return result;
}

test("only an internal immutable capture binds a policy handoff, and public retries use the original inputs", (t) => {
  const { s, owner, reader, run, roles } = fixture(t);
  assert.equal(s.replayedSubmission(owner, run, "dev", payload()), null);
  fail(
    () =>
      s.submitArtifact(owner, run, "dev", {
        ...payload(),
        candidate: candidate(2),
      }),
    400,
  );
  fail(
    () =>
      s.submitArtifact(owner, run, "dev", payload(), {
        ...candidate(1),
        files: ["other.js"],
      }),
    400,
  );
  const r = s.submitArtifact(owner, run, "dev", payload(), candidate(1));
  assert.deepEqual(r.artifacts[0].candidate, candidate(1));
  assert.equal(r.artifacts[0].status, "pending");
  assert.equal(s.getRun(reader, run).artifacts[0].candidate, undefined);
  assert.equal(
    s.replayedSubmission(owner, run, "dev", payload()).artifacts.length,
    1,
  );
  fail(
    () =>
      s.replayedSubmission(owner, run, "dev", {
        ...payload(),
        body: "不同内容",
      }),
    409,
  );
  fail(() => s.replayedSubmission(reader, run, "dev", payload()), 403);
  const job = r.handoffJobs[0];
  assert.deepEqual(s.getDeliveryJob(job.id).candidate, candidate(1));
  fail(() => s.beginDeliveryAction(job.id, "test"), 409);
  const review = {
    requestId: "force",
    action: "accept",
    artifactId: r.artifacts[0].id,
    revision: 1,
  };
  fail(() => s.reviewArtifact(owner, run, review), 409);
  fail(
    () =>
      s.reviewArtifact(owner, run, {
        ...review,
        action: "return",
        feedback: "跳过命令",
      }),
    409,
  );
  fail(
    () => s.submitArtifact(owner, run, "qa", payload("bypass"), candidate(9)),
    409,
  );
  const bad = [
    roles[0],
    { ...roles[1], delivery: { ...roles[1].delivery, files: ["../secrets"] } },
    roles[2],
  ];
  fail(() => s.createTeam(owner, { name: "bad", roles: bad }), 400);
  fail(
    () =>
      s.createTeam(owner, { name: "bad order", roles: [...roles].reverse() }),
    400,
  );
});

test("failed QA returns exact candidate for repair; passed re-test and same-candidate verified release close once", (t) => {
  const { s, owner, reader, run } = fixture(t);
  const original = s.submitArtifact(owner, run, "dev", payload(), candidate(1))
    .artifacts[0];
  const first = start(s, "qa");
  fail(() => s.beginDeliveryAction(first.id, "deploy"), 403);
  const bad = execute(s, first, "test", 1, "第 43 条缺失");
  assert.equal(s.beginDeliveryAction(first.id, "test").created, false);
  assert.deepEqual(
    s.finishDeliveryAction(bad.id, { exitCode: 1, output: "第 43 条缺失" }),
    bad,
  );
  assert.equal(s.getRun(owner, run).currentRoleId, "qa");
  assert.deepEqual(s.listDeliveryWork(), []);
  end(s, first);
  assert.deepEqual(
    s.listDeliveryWork().map((w) => [w.job.id, w.kind, w.operation]),
    [[first.id, "qa", "settle"]],
  );
  const returned = s.settleDelivery(first.id);
  assert.equal(returned.currentRoleId, "dev");
  assert.equal(returned.artifacts[0].status, "returned");
  assert.match(returned.artifacts[0].feedback, new RegExp(bad.id));
  assert.deepEqual(s.settleDelivery(first.id), returned);
  const repair = start(s, "dev");
  end(s, repair, "修复会话的私密文本不应写进产物。");
  assert.deepEqual(
    s.listDeliveryWork().map((w) => [w.job.id, w.kind, w.operation]),
    [[repair.id, "repair", "repair"]],
  );
  fail(
    () => s.submitArtifact(owner, run, "dev", payload("race"), candidate(2)),
    409,
  );
  const revised = s.submitRepair(repair.id, candidate(2));
  assert.deepEqual(s.submitRepair(repair.id, candidate(9)), revised);
  const impl2 = revised.artifacts.at(-1);
  assert.equal(impl2.id, original.id);
  assert.equal(impl2.revision, 2);
  assert.deepEqual(impl2.candidate, candidate(2));
  assert.doesNotMatch(JSON.stringify(revised.artifacts), /修复会话的私密文本/);
  const qa = start(s, "qa"),
    green = execute(s, qa, "test");
  end(s, qa);
  const approved = s.settleDelivery(qa.id),
    report = approved.artifacts.at(-1);
  assert.equal(approved.currentRoleId, "sre");
  assert.deepEqual(report.candidate, candidate(2));
  assert.equal(report.fields.receipt, green.id);
  assert.equal(report.status, "pending");
  assert.deepEqual(
    approved.artifacts.slice(0, 2).map((x) => x.status),
    ["returned", "accepted"],
  );
  const release = start(s, "sre");
  fail(() => s.beginDeliveryAction(release.id, "verify"), 409);
  fail(() => s.beginDeliveryAction(release.id, "test"), 403);
  const deployed = execute(s, release, "deploy");
  const verified = execute(s, release, "verify");
  assert.equal(deployed.target, "test");
  assert.deepEqual(deployed.candidate, verified.candidate);
  assert.equal(verified.artifactId, report.id);
  fail(
    () =>
      s.reviewArtifact(owner, run, {
        requestId: "force",
        action: "accept",
        artifactId: report.id,
        revision: 1,
      }),
    409,
  );
  assert.equal(s.getRun(owner, run).status, "active");
  end(s, release);
  const done = s.settleDelivery(release.id);
  assert.equal(done.status, "completed");
  assert.equal(done.currentRoleId, "sre");
  assert.equal(done.deliveryActions.length, 4);
  assert.deepEqual(s.settleDelivery(release.id), done);
  assert.deepEqual(s.listDeliveryWork(), []);
  const visible = s.getRun(reader, run);
  assert.equal(visible.deliveryActions[0].canRead, false);
  assert.doesNotMatch(
    JSON.stringify(visible),
    /第 43 条缺失|修复会话的私密文本|测试输出/,
  );
});

test("a claimed effect becomes unknown across restart and cannot be sent a second time", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ohoo-action-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "data.sqlite"),
    { s, owner, run } = fixture(t, { file });
  s.submitArtifact(owner, run, "dev", payload(), candidate(1));
  const qa = start(s, "qa"),
    first = s.beginDeliveryAction(qa.id, "test");
  const reopened = createStore(file);
  t.after(() => reopened.close());
  assert.equal(reopened.recoverDeliveryActions(), 1);
  assert.equal(reopened.recoverDeliveryActions(), 0);
  assert.match(reopened.getRun(owner, run).deliveryBlock.reason, /未知/);
  const retry = reopened.beginDeliveryAction(qa.id, "test");
  assert.equal(retry.created, false);
  assert.equal(retry.action.status, "unknown");
  assert.equal(retry.action.id, first.action.id);
  fail(
    () =>
      reopened.finishDeliveryAction(first.action.id, {
        exitCode: 0,
        output: "迟到且状态不确定",
      }),
    409,
  );
  end(reopened, qa);
  const blocked = reopened.settleDelivery(qa.id);
  assert.equal(blocked.status, "active");
  assert.equal(blocked.currentRoleId, "qa");
  assert.ok(blocked.deliveryBlock);
  assert.equal(blocked.artifacts[0].status, "pending");
  assert.deepEqual(reopened.listDeliveryWork(), []);
});

test("missing real receipts block policy nodes and cannot be replaced by model claims or manual approval", (t) => {
  const { s, owner, run } = fixture(t);
  s.submitArtifact(owner, run, "dev", payload(), candidate(1));
  const job = start(s, "qa");
  end(s, job, "所有测试通过，部署健康。");
  const blocked = s.settleDelivery(job.id);
  assert.match(blocked.deliveryBlock.reason, /缺少/);
  assert.equal(blocked.artifacts.length, 1);
  assert.equal(blocked.deliveryActions.length, 0);
  fail(
    () =>
      s.reviewArtifact(owner, run, {
        requestId: "forged",
        action: "accept",
        artifactId: blocked.artifacts[0].id,
        revision: 1,
      }),
    409,
  );
  assert.deepEqual(s.listDeliveryWork(), []);
});

test("the automatic repair budget blocks repeated failures but allows an owner's new explicit submission", (t) => {
  const { s, owner, run } = fixture(t, { maxRepairs: 1 });
  s.submitArtifact(owner, run, "dev", payload(), candidate(1));
  const qa = start(s, "qa");
  execute(s, qa, "test", 1);
  end(s, qa);
  s.settleDelivery(qa.id);
  const repair = start(s, "dev");
  end(s, repair);
  s.submitRepair(repair.id, candidate(2));
  const qa2 = start(s, "qa");
  execute(s, qa2, "test", 1);
  end(s, qa2);
  const stopped = s.settleDelivery(qa2.id);
  assert.equal(stopped.currentRoleId, "dev");
  assert.match(stopped.deliveryBlock.reason, /次数上限/);
  assert.equal(
    stopped.handoffJobs.filter((j) => j.trigger === "return").length,
    1,
  );
  const manual = s.submitArtifact(
    owner,
    run,
    "dev",
    payload("human-fix"),
    candidate(3),
  );
  assert.equal(manual.deliveryBlock, null);
  assert.equal(manual.artifacts.at(-1).revision, 3);
});

test("release verification cannot follow failed deployment and missing verification never closes a run", (t) => {
  for (const [fault, reason] of [
    ["deploy", /部署失败/],
    ["omit", /缺少/],
    ["verify", /验证失败/],
  ]) {
    const { s, owner, run } = fixture(t);
    s.submitArtifact(owner, run, "dev", payload(), candidate(1));
    const qa = start(s, "qa");
    execute(s, qa, "test");
    end(s, qa);
    s.settleDelivery(qa.id);
    const rel = start(s, "sre");
    execute(s, rel, "deploy", fault === "deploy" ? 1 : 0);
    if (fault === "deploy")
      fail(() => s.beginDeliveryAction(rel.id, "verify"), 409);
    if (fault === "verify") execute(s, rel, "verify", 1);
    end(s, rel);
    const blocked = s.settleDelivery(rel.id);
    assert.equal(blocked.status, "active");
    assert.match(blocked.deliveryBlock.reason, reason);
    assert.equal(blocked.artifacts.at(-1).status, "pending");
  }
});

test("members can start a run without exposing host command configuration or weakening its frozen policy", (t) => {
  const { s, run, owner, reader } = fixture(t);
  const teamId = s.getRun(reader, run).teamId;
  const guestTeam = s.getTeam(reader, teamId);
  assert.deepEqual(guestTeam.roles[1].delivery.test, []);
  const started = s.startRun(reader, teamId, { title: "受邀成员委托" });
  assert.deepEqual(started.roles[2].delivery.deploy, []);
  const real = s.getRun(owner, started.id);
  assert.deepEqual(real.roles[1].delivery.test, ["node", "check.js"]);
  assert.equal(real.roles[2].delivery.target, "test");
});
