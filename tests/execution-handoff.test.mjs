import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createExecution } from "../server/execution.mjs";
import { createStore } from "../server/store.mjs";

function fakeRuntime() {
  return {
    sends: [],
    creates: [],
    observations: [],
    async createSession(spec) {
      this.creates.push(spec);
      return { agentId: spec.agentId };
    },
    async sendTurn(agentId, text, options) {
      this.sends.push({ agentId, text, messageId: options.messageId });
      return { status: "idle", accepted: true, text: "仅限开发会话的私人草稿" };
    },
    async observeSession(agentId, { messageId }) {
      this.observations.push({ agentId, messageId });
      return { status: "idle", accepted: true, text: "已按原消息核对" };
    },
  };
}

function setup(t) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ohoo-execution-handoff-")),
  );
  const path = join(root, "store.sqlite");
  let store = createStore(path);
  const owner = store.owner().id;
  const lead = store.redeemInvite(store.createInvite(owner).token, {
    name: "开发负责人",
  }).id;
  const agent = (id, output, extra = {}) => ({
    id,
    name: id,
    kind: "agent",
    assigneeId: owner,
    duty: output,
    output,
    requiredFields: ["依据"],
    environmentId: "local",
    provider: "codex",
    model: "test-model",
    cwd: root,
    ...extra,
  });
  const team = store.createTeam(owner, {
    name: "设计交付",
    goal: "核对准确版本",
    memberIds: [owner, lead],
    roles: [
      agent("intake", "需求说明"),
      agent("dev", "技术方案", { autoStartOnHandoff: true }),
      {
        id: "lead",
        name: "开发负责人",
        kind: "human",
        assigneeId: lead,
        duty: "审阅",
        output: "签收",
        reviewMode: "design",
      },
    ],
  });
  const runId = store.startRun(owner, team.id, { title: "核对订单状态" }).id;
  const runtime = fakeRuntime();
  let execution = createExecution(store, runtime, root);
  const post = (role, requestId, body) =>
    store.submitArtifact(owner, runId, role, {
      requestId,
      title: role === "dev" ? "技术方案" : "需求说明",
      body,
      summary: "已显式共享的摘要",
      fields: { 依据: "固定的验收样例" },
    });
  const decision = (artifact, action, values = {}) =>
    store.reviewArtifact(lead, runId, {
      requestId: action + ":" + artifact.id + ":" + artifact.revision,
      artifactId: artifact.id,
      revision: artifact.revision,
      action,
      ...values,
    });
  const restart = () => {
    execution.stop();
    store.close();
    store = createStore(path);
    execution = createExecution(store, runtime, root);
  };
  t.after(() => {
    execution.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    get execution() {
      return execution;
    },
    owner,
    lead,
    runId,
    runtime,
    post,
    decision,
    restart,
  };
}

async function settled(f, count) {
  for (let i = 0; i < 100; i++) {
    const session = f.store.getSession(f.owner, f.runId, "dev");
    if (
      session.turns.length === count &&
      session.turns.every((turn) => turn.status === "completed")
    )
      return session;
    await delay(5);
  }
  const states = f.store
    .getSession(f.owner, f.runId, "dev")
    .turns.map((t) => [t.status, t.error]);
  assert.fail("Automatic turns did not settle: " + JSON.stringify(states));
}

test("opted-in agent consumes each committed version exactly once; drafting and implementation await explicit publication", async (t) => {
  const f = setup(t);
  f.store.beginTurn(f.owner, f.runId, "intake", {
    requestId: "private",
    text: "源角色的未共享笔记",
  });
  f.store.finishTurn(f.owner, f.runId, "intake", "private", {
    text: "源角色的未共享回复",
  });
  const requirement = f.post("intake", "req", "需求固定内容：读取全部授权订单")
    .artifacts[0];
  await Promise.all([
    f.execution.wake(),
    f.execution.recover(),
    f.execution.wake(),
  ]);
  await settled(f, 1);
  const first = f.runtime.sends[0];
  assert.match(first.text, /读取全部授权订单/);
  assert.match(first.text, /固定的验收样例/);
  assert.doesNotMatch(first.text, /源角色的未共享/);
  assert.ok(first.text.includes(requirement.id));
  assert.equal(
    f.store.getRun(f.lead, f.runId).artifacts.length,
    1,
    "The agent reply itself is not published.",
  );

  const v1 = f.post("dev", "design-1", "设计一稿").artifacts.at(-1);
  f.decision(v1, "return", { feedback: "补上排序回归样例" });
  await f.execution.wake();
  await settled(f, 2);
  assert.match(f.runtime.sends[1].text, /设计一稿/);
  assert.match(f.runtime.sends[1].text, /补上排序回归样例/);
  assert.equal(f.runtime.sends[1].agentId, first.agentId);

  const v2 = f.post("dev", "design-2", "开发修订版正文").artifacts.at(-1);
  const v3 = f
    .decision(v2, "edit", {
      body: "负责人确认版正文",
      fields: { 依据: "由负责人新增排序验证" },
    })
    .artifacts.at(-1);
  f.decision(v3, "confirm_start", { feedback: "按批准版开始实现" });
  await Promise.all([f.execution.wake(), f.execution.recover()]);
  await settled(f, 3);
  const implemented = f.runtime.sends[2];
  assert.equal(implemented.agentId, first.agentId);
  assert.equal(f.runtime.creates.length, 1);
  assert.match(implemented.text, /负责人确认版正文/);
  assert.match(implemented.text, /由负责人新增排序验证/);
  assert.match(implemented.text, /按批准版开始实现/);
  assert.doesNotMatch(
    implemented.text,
    /开发修订版正文|设计一稿|源角色的未共享/,
  );
  const run = f.store.getRun(f.lead, f.runId);
  assert.equal(run.currentRoleId, "dev");
  assert.equal(run.status, "active");
  assert.equal(run.artifacts.at(-1).revision, v3.revision);
  assert.doesNotMatch(JSON.stringify(run), /仅限开发会话的私人草稿/);
  const implementation = f
    .post("dev", "implementation-1", "实现提交：验证输出")
    .artifacts.at(-1);
  f.decision(implementation, "return", { feedback: "权限测试还需复验" });
  await f.execution.wake();
  await settled(f, 4);
  const repair = f.runtime.sends[3];
  assert.equal(repair.agentId, first.agentId);
  assert.match(repair.text, /修改实现/);
  assert.match(repair.text, /负责人确认版正文/);
  assert.match(repair.text, /实现提交：验证输出/);
  assert.match(repair.text, /权限测试还需复验/);
  await f.execution.recover();
  assert.equal(f.runtime.sends.length, 4);
});

test("a claimed but unsent automatic turn can resume from its durable prepared job", async (t) => {
  const f = setup(t);
  f.post("intake", "req", "可恢复的固定输入");
  const [q] = f.store.listQueuedHandoffs();
  const prepared = f.store.claimHandoff(q.id);
  assert.equal(prepared.turn.requestId, q.requestId);
  assert.equal(f.store.listPreparedHandoffs().length, 1);
  // An existing native session alone does not mean this prepared message was sent.
  f.store.bindNativeSession(
    f.owner,
    f.runId,
    "dev",
    "existing-development-agent",
  );
  f.restart();
  await f.execution.recover();
  await settled(f, 1);
  assert.equal(f.runtime.sends.length, 1);
  assert.match(f.runtime.sends[0].text, /可恢复的固定输入/);
  assert.equal(f.runtime.sends[0].agentId, "existing-development-agent");
  assert.equal(f.runtime.creates.length, 0);
  assert.equal(
    f.runtime.observations.length,
    0,
    "Prepared work can be sent, not merely observed.",
  );
});

test("a handoff marked dispatched before a restart is reconciled without sending again", async (t) => {
  const f = setup(t);
  f.post("intake", "req", "保留已发消息的身份");
  const [q] = f.store.listQueuedHandoffs();
  f.store.claimHandoff(q.id);
  f.store.bindNativeSession(f.owner, f.runId, "dev", "test-native-id");
  assert.equal(f.store.markHandoffDispatched(q.id), true);
  f.restart();
  await f.execution.recover();
  const session = await settled(f, 1);
  assert.equal(session.turns[0].response, "已按原消息核对");
  assert.equal(f.runtime.sends.length, 0);
  assert.equal(f.runtime.observations.length, 1);
  assert.equal(f.runtime.observations[0].agentId, "test-native-id");
});
