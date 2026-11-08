import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createStore } from "../server/store.mjs";
import { createAuth, ownerKey } from "../server/auth.mjs";
import { createExecution } from "../server/execution.mjs";
import { createHttpService } from "../server/http.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function successful(text) {
  return { status: "idle", accepted: true, text };
}

// Only the side of the runtime contract that would contact a real daemon is injected.
function recordingRuntime() {
  return {
    creates: [],
    sends: [],
    observes: [],
    reply: () => successful("执行器的私有回复"),
    observed: () => ({ status: "unknown", accepted: null, text: "" }),
    async listProviders() {
      return [{ provider: "codex", status: "ready" }];
    },
    async createSession(spec) {
      this.creates.push(spec);
      return { agentId: spec.agentId };
    },
    async sendTurn(agentId, text, options) {
      const entry = { agentId, text, messageId: options.messageId };
      this.sends.push(entry);
      options.onEvent?.({ type: "accepted", status: "running" });
      return this.reply(entry);
    },
    async observeSession(agentId, { messageId } = {}) {
      const entry = { agentId, messageId };
      this.observes.push(entry);
      return this.observed(entry);
    },
  };
}

async function until(read, predicate) {
  const deadline = Date.now() + 3000;
  let result;
  do {
    result = await read();
    if (predicate(result)) return result;
    await delay(5);
  } while (Date.now() < deadline);
  assert.fail("Timed out waiting for the expected test state.");
}

function workspace(t) {
  const data = realpathSync(mkdtempSync(join(tmpdir(), "ohoo-http-")));
  const root = join(data, "work");
  mkdirSync(root);
  const stack = [];
  t.after(async () => {
    try {
      for (const app of stack.toReversed()) await app.stop();
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });
  return {
    async boot(runtime = recordingRuntime()) {
      const store = createStore(join(data, "workbench.sqlite"));
      const auth = createAuth(data);
      const execution = createExecution(store, runtime, root);
      const server = createHttpService({
        store,
        auth,
        execution,
        runtime,
        workspace: root,
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const origin = "http://127.0.0.1:" + server.address().port;
      let stopped = false;
      const app = {
        runtime,
        execution,
        origin,
        async request(route, { cookie, body, headers = {} } = {}) {
          const response = await fetch(origin + "/api/" + route, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              ...(body === undefined
                ? {}
                : { "Content-Type": "application/json" }),
              ...(cookie ? { Cookie: cookie } : {}),
              ...headers,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          return {
            status: response.status,
            data: await response.json(),
            headers: response.headers,
          };
        },
        async login(token, name) {
          const result = await this.request("login", { body: { token, name } });
          assert.equal(result.status, 200);
          const header = result.headers.get("set-cookie");
          assert.match(header, /HttpOnly/);
          assert.match(header, /SameSite=Strict/);
          return { user: result.data, cookie: header.split(";")[0] };
        },
        async ownerLogin() {
          return this.login(ownerKey(data));
        },
        async invite(owner, name) {
          const invite = await this.request("invites", {
            cookie: owner.cookie,
            body: {},
          });
          assert.equal(invite.status, 201);
          const token = new URLSearchParams(
            new URL(invite.data.url).hash.slice(1),
          ).get("invite");
          return { ...(await this.login(token, name)), token };
        },
        async stop() {
          if (stopped) return;
          stopped = true;
          execution.stop();
          await new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
          auth.close();
          store.close();
        },
      };
      stack.push(app);
      return app;
    },
  };
}

async function createRun(app, draftRoleId = "draft") {
  const owner = await app.ownerLogin(),
    receiver = await app.invite(owner, "需求评审人");
  const team = await app.request("teams", {
    cookie: owner.cookie,
    body: {
      name: "需求整理团队",
      goal: "交付已签收的需求说明",
      memberIds: [receiver.user.id],
      roles: [
        {
          id: draftRoleId,
          kind: "agent",
          name: "需求整理",
          assigneeId: owner.user.id,
          duty: "起草需求说明",
          provider: "codex",
          model: "test-model",
          cwd: ".",
          environmentId: "local",
          skills: ["需求整理"],
          clis: [],
          output: "需求说明",
          requiredFields: ["验收样例"],
        },
        {
          id: "review",
          kind: "human",
          name: "负责人",
          assigneeId: receiver.user.id,
          duty: "核对范围",
          output: "签收记录",
        },
      ],
    },
  });
  assert.equal(team.status, 201);
  const run = await app.request("teams/" + team.data.id + "/runs", {
    cookie: owner.cookie,
    body: { title: "订单范围" },
  });
  assert.equal(run.status, 201);
  const path = "runs/" + run.data.id;
  return {
    owner,
    receiver,
    path,
    role: path + "/roles/" + encodeURIComponent(draftRoleId),
  };
}

test("loopback HTTP requires a login, rejects a foreign origin, and gives invitations distinct scopes", async (t) => {
  const app = await workspace(t).boot();
  assert.equal((await app.request("health")).status, 200);
  for (const route of ["me", "members", "teams", "runs", "providers"])
    assert.equal((await app.request(route)).status, 401);
  const { owner, receiver, path, role } = await createRun(app);
  const forged = await app.request("invites", {
    cookie: owner.cookie,
    body: {},
    headers: { Origin: "https://foreign.invalid" },
  });
  assert.equal(forged.status, 403);
  assert.equal(forged.data.error, "bad_origin");
  assert.equal(
    (
      await app.request("me", {
        cookie: owner.cookie,
        headers: { Origin: app.origin },
      })
    ).data.id,
    owner.user.id,
  );
  assert.notEqual(receiver.user.id, owner.user.id);
  assert.equal(
    (await app.request("me", { cookie: receiver.cookie })).data.role,
    "member",
  );
  assert.equal(
    (
      await app.request("login", {
        body: { token: receiver.token, name: "重复兑换" },
      })
    ).status,
    410,
  );
  assert.equal(
    (await app.request("invites", { cookie: receiver.cookie, body: {} }))
      .status,
    403,
  );
  assert.equal(
    (await app.request("providers", { cookie: receiver.cookie })).status,
    403,
  );
  assert.equal(
    (await app.request(path, { cookie: receiver.cookie })).status,
    200,
  );
  assert.equal(
    (await app.request(role + "/session", { cookie: receiver.cookie })).status,
    403,
  );
  assert.equal(
    (
      await app.request(role + "/turns", {
        cookie: receiver.cookie,
        body: { requestId: "intruder", text: "test" },
      })
    ).status,
    403,
  );
  const outside = await app.invite(owner, "其他团队成员");
  assert.equal(
    (await app.request(path, { cookie: outside.cookie })).status,
    404,
  );
  assert.deepEqual(
    (await app.request("runs", { cookie: outside.cookie })).data,
    [],
  );
  await app.request("logout", { cookie: receiver.cookie, body: {} });
  assert.equal(
    (await app.request("me", { cookie: receiver.cookie })).status,
    401,
  );
  assert.equal((await app.request("me", { cookie: owner.cookie })).status, 200);
  assert.equal(app.runtime.sends.length, 0);
});

test("two real HTTP callers drive one private conversation and only the selected handoff reaches review", async (t) => {
  const app = await workspace(t).boot();
  const { owner, receiver, path, role } = await createRun(app);
  const ownerPost = (route, body) =>
    app.request(route, { cookie: owner.cookie, body });
  const reviews = (body) =>
    app.request(path + "/review", { cookie: receiver.cookie, body });
  const privateSession = async () =>
    (await app.request(role + "/session", { cookie: owner.cookie })).data;
  const openings = await Promise.all([
    ownerPost(role + "/session/open", {}),
    ownerPost(role + "/session/open", {}),
  ]);
  assert.deepEqual(
    openings.map((r) => r.status),
    [200, 200],
  );
  assert.equal(openings[0].data.id, openings[1].data.id);
  assert.equal(app.runtime.creates.length, 1);
  const gate = deferred();
  app.runtime.reply = () => gate.promise;
  const first = { requestId: "one", text: "私人会前笔记" };
  const duplicate = await Promise.all([
    ownerPost(role + "/turns", first),
    ownerPost(role + "/turns", first),
  ]);
  assert.deepEqual(
    duplicate.map((r) => r.status),
    [202, 202],
  );
  await until(
    () => app.runtime.sends.length,
    (n) => n === 1,
  );
  assert.equal(
    (await ownerPost(role + "/turns", { ...first, text: "同键不同文本" }))
      .status,
    409,
  );
  assert.equal(
    (
      await ownerPost(role + "/turns", {
        requestId: "another",
        text: "并发回合",
      })
    ).status,
    409,
  );
  const deliver = {
    requestId: "submit1",
    title: "订单需求",
    body: "只导出有权读取的订单。",
    summary: "请核对范围。",
    fields: { 验收样例: "43 条" },
  };
  assert.equal((await ownerPost(role + "/artifacts", deliver)).status, 409);
  gate.resolve(successful("私有执行回复一"));
  await until(privateSession, (s) => s.turns[0].status === "completed");
  app.runtime.reply = () => successful("私有执行回复二");
  assert.equal(
    (
      await ownerPost(role + "/turns", {
        requestId: "two",
        text: "再核对排序。",
      })
    ).status,
    202,
  );
  const second = await until(
    privateSession,
    (s) => s.turns[1]?.status === "completed",
  );
  assert.deepEqual(
    second.messages.map((m) => m.text),
    ["私人会前笔记", "私有执行回复一", "再核对排序。", "私有执行回复二"],
  );
  assert.equal(app.runtime.creates.length, 1);
  assert.equal(app.runtime.sends.length, 2);
  assert.equal(app.runtime.sends[0].agentId, app.runtime.sends[1].agentId);
  assert.notEqual(
    app.runtime.sends[0].messageId,
    app.runtime.sends[1].messageId,
  );
  assert.equal(
    (await ownerPost(role + "/turns", first)).data.status,
    "completed",
  );
  const before = (await app.request(path, { cookie: receiver.cookie })).data;
  assert.equal(before.artifacts.length, 0);
  const approved = await ownerPost(role + "/artifacts", deliver);
  assert.equal(approved.status, 200);
  assert.equal(
    (await ownerPost(role + "/artifacts", deliver)).data.artifacts.length,
    1,
  );
  const inbox = (await app.request(path, { cookie: receiver.cookie })).data;
  const a = inbox.artifacts[0];
  assert.equal(inbox.currentRoleId, "review");
  assert.equal(a.canRead, true);
  assert.equal(a.body, deliver.body);
  assert.equal(a.summary, deliver.summary);
  assert.doesNotMatch(
    JSON.stringify(inbox),
    /私人会前笔记|私有执行回复|再核对排序/,
  );
  assert.ok(!JSON.stringify(inbox).includes(second.nativeSessionId));
  const decision = {
    artifactId: a.id,
    revision: 1,
    action: "return",
    feedback: "补充分页覆盖。",
    requestId: "return",
  };
  assert.equal((await ownerPost(path + "/review", decision)).status, 403);
  assert.equal((await reviews(decision)).data.currentRoleId, "draft");
  const v2 = (
    await ownerPost(role + "/artifacts", {
      ...deliver,
      requestId: "submit2",
      body: "跨页检查全部 43 条。",
    })
  ).data.artifacts.at(-1);
  assert.equal(v2.id, a.id);
  assert.equal(v2.revision, 2);
  assert.equal(
    (
      await reviews({
        requestId: "old",
        artifactId: a.id,
        revision: 1,
        action: "accept",
      })
    ).status,
    409,
  );
  const accepted = {
    requestId: "accept",
    artifactId: a.id,
    revision: 2,
    action: "accept",
  };
  const finished = await reviews(accepted);
  assert.equal(finished.status, 200);
  assert.equal(finished.data.status, "completed");
  assert.equal(finished.data.artifacts[1].reviewedBy, receiver.user.id);
  assert.deepEqual((await reviews(accepted)).data, finished.data);
  assert.equal(app.runtime.sends.length, 2);
});

test("after restart a pending send is reconciled with its original native message ID without redispatch", async (t) => {
  const env = workspace(t);
  const initial = await env.boot();
  const { owner, receiver, role, path } = await createRun(initial);
  const gate = deferred();
  initial.runtime.reply = () => gate.promise;
  const command = {
    requestId: "interrupt",
    text: "已提交到远端但尚未收到结果",
  };
  assert.equal(
    (
      await initial.request(role + "/turns", {
        cookie: owner.cookie,
        body: command,
      })
    ).status,
    202,
  );
  await until(
    () => initial.runtime.sends.length,
    (count) => count === 1,
  );
  const previous = initial.runtime.sends[0];
  const oldSession = (
    await initial.request(role + "/session", { cookie: owner.cookie })
  ).data;
  assert.equal(oldSession.turns[0].status, "pending");
  await initial.stop();
  // The old process's callback must never alter a reopened database.
  gate.resolve(successful("迟到的旧进程回调"));
  const resumed = await env.boot();
  resumed.runtime.observed = () => successful("恢复确认的远端结果");
  await resumed.execution.recover();
  assert.deepEqual(resumed.runtime.observes, [
    { agentId: previous.agentId, messageId: previous.messageId },
  ]);
  const s = (await resumed.request(role + "/session", { cookie: owner.cookie }))
    .data;
  assert.equal(s.id, oldSession.id);
  assert.equal(s.nativeSessionId, oldSession.nativeSessionId);
  assert.equal(s.turns[0].status, "completed");
  assert.deepEqual(
    s.messages.map((m) => m.text),
    [command.text, "恢复确认的远端结果"],
  );
  assert.equal(
    (
      await resumed.request(role + "/turns", {
        cookie: owner.cookie,
        body: command,
      })
    ).data.status,
    "completed",
  );
  await resumed.execution.recover();
  assert.equal(resumed.runtime.sends.length, 0);
  assert.equal(resumed.runtime.creates.length, 0);
  assert.equal(resumed.runtime.observes.length, 1);
  const receiverRun = (await resumed.request(path, { cookie: receiver.cookie }))
    .data;
  assert.doesNotMatch(JSON.stringify(receiverRun), /恢复确认的远端结果/);
});

test("an unconfirmed empty observation stays pending; a confirmed empty result releases the next turn", async (t) => {
  const env = workspace(t),
    app = await env.boot();
  const { owner, role } = await createRun(app);
  const awaiting = { status: "unknown", accepted: true, text: "" };
  app.runtime.reply = () => awaiting;
  const input = { requestId: "no-output", text: "运行只产生工具输出。" };
  assert.equal(
    (await app.request(role + "/turns", { cookie: owner.cookie, body: input }))
      .status,
    202,
  );
  const snapshot = async () =>
    (await app.request(role + "/session", { cookie: owner.cookie })).data;
  const pending = await until(
    snapshot,
    (result) => result.runtimeState === "unknown",
  );
  assert.equal(pending.turns[0].status, "pending");
  await app.stop();

  const after = await env.boot();
  // The adapter has now established completion for the original message.
  after.runtime.observed = () => successful("");
  const result = (
    await after.request(role + "/session", { cookie: owner.cookie })
  ).data;
  assert.equal(result.turns[0].status, "completed");
  assert.equal(result.turns[0].response, "");
  assert.equal(result.runtimeState, null);
  assert.equal(after.runtime.sends.length, 0);
  assert.equal(after.runtime.observes.length, 1);
  const next = await after.request(role + "/turns", {
    cookie: owner.cookie,
    body: { requestId: "after-empty", text: "继续" },
  });
  assert.equal(next.status, 202);
  await until(
    async () =>
      (await after.request(role + "/session", { cookie: owner.cookie })).data,
    (session) => session.turns[1]?.status === "completed",
  );
  assert.equal(after.runtime.sends.length, 1);
});

test("path segments support encoded role IDs and reject malformed escaping", async (t) => {
  const app = await workspace(t).boot();
  const id = "需求/初稿 v1";
  const { owner, role, path } = await createRun(app, id);
  const s = await app.request(role + "/session/open", {
    cookie: owner.cookie,
    body: {},
  });
  assert.equal(s.status, 200);
  assert.equal(s.data.roleId, id);
  const bad = await app.request(path + "/roles/%E0%A4/session", {
    cookie: owner.cookie,
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, "bad_path");
});

test("only the assignee can resolve an unknown turn after confirming the native session stopped", async (t) => {
  const app = await workspace(t).boot();
  const { owner, receiver, role } = await createRun(app);
  const unknown = { status: "unknown", accepted: null, text: "" };
  let nativeStatus = "running";
  app.runtime.reply = () => unknown;
  app.runtime.observed = ({ messageId }) =>
    messageId ? unknown : { status: nativeStatus };
  const requestId = "核对/这一次";
  const path = role + "/turns/" + encodeURIComponent(requestId) + "/resolve";
  const post = (cookie, body) => app.request(path, { cookie, body });
  await app.request(role + "/turns", {
    cookie: owner.cookie,
    body: { requestId, text: "执行后回执下落不明" },
  });
  const snapshot = async () =>
    (await app.request(role + "/session", { cookie: owner.cookie })).data;
  await until(snapshot, (s) => s.runtimeState === "unknown");
  const before = app.runtime.observes.length;
  const intruder = await post(receiver.cookie, { confirmed: true });
  assert.equal(intruder.status, 403);
  const anonymous = await post(null, { confirmed: true });
  assert.equal(anonymous.status, 401);
  const noConfirmation = await post(owner.cookie, { confirmed: false });
  assert.equal(noConfirmation.status, 400);
  assert.equal(noConfirmation.data.error, "confirmation_required");
  assert.equal(app.runtime.observes.length, before);
  const busy = await post(owner.cookie, { confirmed: true });
  assert.equal(busy.status, 409);
  assert.equal(busy.data.error, "still_running");
  assert.equal((await snapshot()).turns[0].status, "pending");
  nativeStatus = "idle";
  const resolved = await post(owner.cookie, { confirmed: true });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.data.turns[0].status, "failed");
  const observedCount = app.runtime.observes.length;
  assert.equal((await post(owner.cookie, { confirmed: true })).status, 200);
  assert.equal(app.runtime.observes.length, observedCount);
  assert.equal(app.runtime.sends.length, 1);
});
