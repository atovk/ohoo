import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAuth, ownerKey } from "../server/auth.mjs";
import { createStore } from "../server/store.mjs";
import { createExecution } from "../server/execution.mjs";
import { createHttpService } from "../server/http.mjs";

async function until(read, description) {
  const deadline = Date.now() + 3000;
  do {
    const value = read();
    if (value) return value;
    await delay(5);
  } while (Date.now() < deadline);
  assert.fail("Timed out waiting for " + description);
}

async function fixture(t) {
  const data = realpathSync(mkdtempSync(join(tmpdir(), "ohoo-agent-handoff-")));
  const workspace = join(data, "work");
  mkdirSync(workspace);
  const store = createStore(join(data, "test.sqlite"));
  const auth = createAuth(data);
  const runtime = {
    sends: [],
    gate: null,
    async createSession({ agentId }) {
      return { agentId };
    },
    async sendTurn(agentId, text, { messageId }) {
      this.sends.push({ agentId, text, messageId });
      if (this.gate) await this.gate;
      return { status: "idle", accepted: true, text: "PRIVATE_AGENT_REPLY" };
    },
  };
  const execution = createExecution(store, runtime, workspace);
  const server = createHttpService({
    store,
    auth,
    execution,
    runtime,
    workspace,
  });
  t.after(async () => {
    execution.stop();
    try {
      await new Promise((resolve) => server.close(resolve));
    } finally {
      auth.close();
      store.close();
      rmSync(data, { recursive: true, force: true });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;

  async function request(path, cookie, body, expected = 200) {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, expected, path + " " + JSON.stringify(value));
    return { value, headers: response.headers };
  }

  async function login(token, name) {
    const { value, headers } = await request("/login", null, { token, name });
    return { id: value.id, cookie: headers.get("set-cookie").split(";")[0] };
  }
  const owner = await login(ownerKey(data));
  const invitation = (await request("/invites", owner.cookie, {}, 201)).value;
  const token = new URLSearchParams(new URL(invitation.url).hash.slice(1)).get(
    "invite",
  );
  const lead = await login(token, "设计负责人");
  return { owner, lead, store, runtime, request };
}

test("HTTP dispatches delegated development, review revisions and approved implementation exactly once", async (t) => {
  const { owner, lead, store, runtime, request } = await fixture(t);
  function agent(id, name, output) {
    return {
      id,
      kind: "agent",
      name,
      assigneeId: owner.id,
      duty: name,
      output,
      environmentId: "local",
      provider: "codex",
      model: "test-model",
      cwd: ".",
    };
  }
  const team = (
    await request(
      "/teams",
      owner.cookie,
      {
        name: "需求设计团队",
        goal: "交付负责人签收的实现结果",
        memberIds: [lead.id],
        roles: [
          agent("req", "需求整理", "需求说明"),
          { ...agent("dev", "开发设计", "技术设计"), autoStartOnHandoff: true },
          {
            id: "lead",
            name: "负责人",
            kind: "human",
            assigneeId: lead.id,
            duty: "修改或确认设计",
            output: "签收决定",
            reviewMode: "design",
          },
        ],
      },
      201,
    )
  ).value;
  const run = (
    await request(
      `/teams/${team.id}/runs`,
      owner.cookie,
      { title: "订单导出" },
      201,
    )
  ).value;
  const path = "/runs/" + run.id;
  const postArtifact = (role, payload, status) =>
    request(path + `/roles/${role}/artifacts`, owner.cookie, payload, status);
  const decide = async (payload, status) =>
    (await request(path + "/review", lead.cookie, payload, status)).value;
  const dispatch = (number) =>
    until(() => runtime.sends[number - 1], `runtime dispatch #${number}`);
  // Reading the durable turn directly never opens, wakes or reconciles a session.
  const completedTurns = (role, count) =>
    until(
      () =>
        store
          .getSession(owner.id, run.id, role)
          .turns.filter((turn) => turn.status === "completed").length === count,
      `${role} to have ${count} completed turns`,
    );

  const privateText = "PRIVATE_REQUIREMENTS_NOTE";
  await request(
    path + "/roles/req/turns",
    owner.cookie,
    { requestId: "private-turn", text: privateText },
    202,
  );
  await completedTurns("req", 1);
  const requirement = {
    requestId: "handoff-req",
    title: "导出要求",
    body: "EXPLICIT_REQUIREMENT_BODY",
    fields: { 验收: "SAMPLE_43" },
    summary: "SCOPE_SUMMARY",
  };
  const handedOff = (await postArtifact("req", requirement)).value;
  assert.equal(handedOff.currentRoleId, "dev");
  assert.equal(handedOff.artifacts[0].status, "accepted");
  // Observe only the external runtime until it receives the handoff. A GET or
  // a manual development turn here would mask a missing write-side dispatch.
  const received = await dispatch(2);
  assert.notEqual(received.agentId, runtime.sends[0].agentId);
  for (const content of [
    requirement.body,
    requirement.summary,
    requirement.fields.验收,
  ]) {
    assert.ok(
      received.text.includes(content),
      "missing explicit handoff content: " + content,
    );
  }
  assert.doesNotMatch(
    received.text,
    /PRIVATE_REQUIREMENTS_NOTE|PRIVATE_AGENT_REPLY/,
  );
  await completedTurns("dev", 1);
  await postArtifact("req", requirement);

  const draft = {
    requestId: "draft-v1",
    title: "设计草稿",
    summary: "请负责人评审",
    body: "DESIGN_V1",
  };
  const submitted = (await postArtifact("dev", draft)).value;
  const design = submitted.artifacts.find((a) => a.fromRoleId === "dev");
  assert.equal(submitted.currentRoleId, "lead");
  const edit = {
    requestId: "edit-v1",
    action: "edit",
    artifactId: design.id,
    revision: 1,
    body: "REVIEWER_EDIT_V2",
    feedback: "先复用原查询。",
  };
  const edited = await decide(edit);
  assert.deepEqual(
    edited.artifacts
      .filter((a) => a.id === design.id)
      .map((a) => [a.revision, a.body]),
    [
      [1, draft.body],
      [2, edit.body],
    ],
  );
  const v2 = edited.artifacts.find(
    (a) => a.id === design.id && a.revision === 2,
  );
  assert.equal(v2.editedBy, lead.id);
  assert.equal(v2.supersedesRevision, 1);
  assert.equal((await decide(edit)).artifacts.length, edited.artifacts.length);
  await decide({ ...edit, requestId: "stale-edit", body: "STALE" }, 409);
  await decide(
    {
      action: "confirm_start",
      requestId: "stale-confirm",
      artifactId: design.id,
      revision: 1,
    },
    409,
  );

  const sendBack = {
    action: "return",
    requestId: "return-v2",
    artifactId: design.id,
    revision: 2,
    feedback: "FEEDBACK_VERIFY_PERMISSIONS",
  };
  await decide(sendBack);
  const revisionTurn = await dispatch(3);
  assert.ok(revisionTurn.text.includes(edit.body));
  assert.ok(revisionTurn.text.includes(sendBack.feedback));
  await completedTurns("dev", 2);
  await decide(sendBack);
  const revised = {
    ...draft,
    requestId: "draft-v3",
    body: "DEVELOPER_REVISION_V3",
  };
  await postArtifact("dev", revised);
  const finalEdit = {
    ...edit,
    requestId: "edit-v3",
    revision: 3,
    body: "APPROVED_IMPLEMENTATION_V4",
  };
  await decide(finalEdit);

  let release;
  runtime.gate = new Promise((resolve) => {
    release = resolve;
  });
  const approval = {
    requestId: "confirm-v4",
    action: "confirm_start",
    artifactId: design.id,
    revision: 4,
    feedback: "START_ONLY_V4",
  };
  try {
    const confirmed = await decide(approval);
    assert.equal(confirmed.status, "active");
    assert.equal(confirmed.phase, "implementation");
    assert.equal(confirmed.currentRoleId, "dev");
    assert.equal(confirmed.approvedDesign.artifactId, design.id);
    assert.equal(confirmed.approvedDesign.revision, 4);
    const implementationTurn = await dispatch(4);
    assert.ok(implementationTurn.text.includes(finalEdit.body));
    assert.ok(implementationTurn.text.includes(approval.feedback));
    for (const staleBody of [draft.body, edit.body, revised.body]) {
      assert.ok(
        !implementationTurn.text.includes(staleBody),
        "implementation received superseded design: " + staleBody,
      );
    }
    assert.doesNotMatch(
      implementationTurn.text,
      /PRIVATE_REQUIREMENTS_NOTE|PRIVATE_AGENT_REPLY/,
    );
    await Promise.all([decide(approval), decide(approval)]);
    await postArtifact(
      "dev",
      {
        requestId: "too-early",
        title: "提前交付",
        summary: "仍在实现",
        body: "blocked",
      },
      409,
    );
    assert.equal(runtime.sends.length, 4);
  } finally {
    runtime.gate = null;
    release();
  }
  await completedTurns("dev", 3);
  const implementation = {
    requestId: "deliver-implementation",
    title: "实现结果",
    body: "实现已通过权限回归",
    summary: "请验收实现。",
  };
  const delivered = (await postArtifact("dev", implementation)).value;
  const result = delivered.artifacts.find((a) => a.phase === "implementation");
  assert.ok(result);
  assert.notEqual(result.id, design.id);
  assert.equal(result.body, implementation.body);
  assert.equal(delivered.status, "active");
  assert.equal(delivered.currentRoleId, "lead");
  const accept = {
    requestId: "accept-result",
    action: "accept",
    artifactId: result.id,
    revision: result.revision,
  };
  await decide(accept);
  const finished = await decide(accept);
  assert.equal(finished.status, "completed");
  assert.equal(
    finished.artifacts.find((a) => a.id === result.id).status,
    "accepted",
  );
  assert.equal(
    finished.artifacts.find((a) => a.id === design.id && a.revision === 1).body,
    draft.body,
  );
  assert.deepEqual(
    finished.handoffJobs.map((j) => j.trigger),
    ["handoff", "return", "confirm_start"],
  );
  assert.ok(finished.handoffJobs.every((j) => j.status === "completed"));
  assert.equal(runtime.sends.length, 4);
  assert.equal(new Set(runtime.sends.map((s) => s.messageId)).size, 4);
  assert.doesNotMatch(
    JSON.stringify(finished),
    /PRIVATE_REQUIREMENTS_NOTE|PRIVATE_AGENT_REPLY/,
  );
});
