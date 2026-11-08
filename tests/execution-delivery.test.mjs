import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createExecution } from "../server/execution.mjs";
import { createStore } from "../server/store.mjs";

const candidate = (digit) => ({
  digest: digit.repeat(64),
  files: ["service.js"],
});
const first = candidate("1"),
  revised = candidate("2");

function fixture(
  t,
  {
    skipTools = false,
    failInitial = false,
    maxRepairs = 1,
    loseDeployment = false,
  } = {},
) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "ohoo-delivery-execution-")),
  );
  const database = join(root, "state.sqlite");
  let store = createStore(database);
  const owner = store.owner().id;
  const qaCommand = [
    process.execPath,
    "-e",
    "const fail=process.env.REPRO==='yes';console.log(fail?'expected active orders only':'all example orders passed');process.exit(fail?1:0)",
  ];
  const releaseCommand = (op) => [
    process.execPath,
    "-e",
    `console.log('${op}: '+process.env.CANDIDATE)`,
  ];
  function agent(id, extra = {}) {
    return {
      id,
      kind: "agent",
      name: id,
      assigneeId: owner,
      autoStartOnHandoff: true,
      duty: id + " duty",
      output: id + " output",
      environmentId: "local",
      provider: "codex",
      model: "testing",
      cwd: root,
      ...extra,
    };
  }
  const team = store.createTeam(owner, {
    name: "Delivery test",
    goal: "Verify controlled commands",
    memberIds: [owner],
    roles: [
      agent("dev"),
      agent("qa", {
        delivery: {
          kind: "qa",
          files: first.files,
          test: qaCommand,
          maxRepairs,
        },
      }),
      agent("sre", {
        delivery: {
          kind: "release",
          target: "isolated-test",
          deploy: releaseCommand("deploy"),
          verify: releaseCommand("verify"),
        },
      }),
    ],
  });
  const run = store.startRun(owner, team.id, {
    title: "Verify a fixed candidate",
  });
  const trace = { prompts: [], commands: [], captures: 0 };
  function executeTool(jobId, op) {
    const { created, action } = store.beginDeliveryAction(jobId, op);
    assert.ok(created, "one native action per job and operation");
    trace.commands.push({ op, jobId, digest: action.candidate.digest });
    if (loseDeployment && op === "deploy") {
      store.markDeliveryActionUnknown(action.id, "Lost deployment receipt.");
      return false;
    }
    // A real process with the exact argv authorized by the role. The fixture's
    // runtime chooses when to invoke the helper, independently of its prose.
    const [program, ...args] = action.argv;
    const child = spawnSync(program, args, {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        CANDIDATE: action.candidate.digest,
        REPRO:
          failInitial && action.candidate.digest === first.digest
            ? "yes"
            : "no",
      },
    });
    assert.ifError(child.error);
    store.finishDeliveryAction(action.id, {
      exitCode: child.status,
      output: child.stdout + child.stderr,
    });
    return child.status === 0;
  }
  const gate = {
    instructions: async (job) => "invoke-job " + job.id,
    async capture(currentRun, role) {
      trace.captures++;
      assert.equal(currentRun.id, run.id);
      assert.equal(role.id, "dev");
      return revised;
    },
  };
  const runtime = {
    async createSession({ agentId }) {
      return { agentId };
    },
    async sendTurn(agentId, text) {
      const jobId = /invoke-job ([\w-]+)/.exec(text)?.[1];
      trace.prompts.push({ agentId, jobId, text });
      if (jobId && !skipTools) {
        const work = store.getDeliveryJob(jobId);
        if (work.kind === "qa") executeTool(jobId, "test");
        else if (work.kind === "release" && executeTool(jobId, "deploy"))
          executeTool(jobId, "verify");
      }
      return {
        status: "idle",
        accepted: true,
        text: "Private model prose claiming everything worked",
      };
    },
    async observeSession() {
      return { status: "unknown", accepted: null, text: "" };
    },
  };
  let execution = createExecution(store, runtime, root, gate);
  const post = (snapshot = first) =>
    store.submitArtifact(
      owner,
      run.id,
      "dev",
      {
        requestId: "submit-candidate",
        title: "Orders release",
        body: "Selected implementation description",
        summary: "Please test this candidate",
        fields: {},
      },
      snapshot,
    );
  const view = () => store.getRun(owner, run.id);
  const restart = () => {
    execution.stop();
    store.close();
    store = createStore(database);
    execution = createExecution(store, runtime, root, gate);
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
    trace,
    owner,
    post,
    run,
    view,
    restart,
  };
}

async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Delivery state did not advance.");
}

test("failed QA triggers one repair, retest, then deploy and verify on the identical passed candidate", async (t) => {
  const f = fixture(t, { failInitial: true });
  f.post();
  await f.execution.wake();
  await until(() => f.view().status === "completed");
  const state = f.view();
  assert.deepEqual(
    f.trace.commands.map((c) => [c.op, c.digest]),
    [
      ["test", first.digest],
      ["test", revised.digest],
      ["deploy", revised.digest],
      ["verify", revised.digest],
    ],
  );
  assert.equal(f.trace.captures, 1);
  const revisions = state.artifacts.filter((a) => a.fromRoleId === "dev");
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].id, revisions[1].id);
  assert.deepEqual(
    revisions.map((a) => [a.revision, a.candidate.digest]),
    [
      [1, first.digest],
      [2, revised.digest],
    ],
  );
  assert.ok(
    f.trace.prompts.some(
      (p) => !p.jobId && p.text.includes("expected active orders only"),
    ),
  );
  assert.doesNotMatch(JSON.stringify(state), /Private model prose|invoke-job/);
  await f.execution.recover();
  assert.equal(f.trace.commands.length, 4);
});

test("a model success claim without a QA command receipt cannot promote a candidate", async (t) => {
  const f = fixture(t, { skipTools: true });
  f.post();
  await f.execution.wake();
  await until(
    () =>
      f.view().handoffJobs[0]?.status === "completed" &&
      f.store.listDeliveryWork().length === 0,
  );
  await f.execution.recover();
  const state = f.view();
  assert.equal(state.status, "active");
  assert.equal(state.currentRoleId, "qa");
  assert.match(state.deliveryBlock.reason, /缺少.*命令回执/);
  assert.equal(f.trace.commands.length, 0);
  assert.equal(state.handoffJobs.length, 1);
});

test("a missing deployment receipt blocks verify and completion without replaying the command", async (t) => {
  const f = fixture(t, { loseDeployment: true });
  f.post();
  await f.execution.wake();
  await until(
    () =>
      f.view().handoffJobs.length === 2 &&
      f.view().handoffJobs.at(-1).status === "completed" &&
      f.store.listDeliveryWork().length === 0,
  );
  const state = f.view();
  assert.equal(state.status, "active");
  assert.equal(state.currentRoleId, "sre");
  assert.match(state.deliveryBlock.reason, /未知|核对/);
  f.restart();
  await f.execution.recover();
  assert.deepEqual(
    f.trace.commands.map((x) => x.op),
    ["test", "deploy"],
  );
});

test("a configured limit of zero repairs returns the failed candidate for human attention", async (t) => {
  const f = fixture(t, { failInitial: true, maxRepairs: 0 });
  f.post();
  await f.execution.wake();
  await until(() => Boolean(f.view().deliveryBlock));
  const state = f.view();
  assert.equal(state.currentRoleId, "dev");
  assert.equal(state.status, "active");
  assert.match(state.deliveryBlock.reason, /修复次数上限/);
  assert.equal(f.trace.captures, 0);
  assert.equal(f.trace.prompts.length, 1);
  await f.execution.recover();
  assert.deepEqual(
    f.trace.commands.map((c) => c.op),
    ["test"],
  );
});

test("startup routes a completed QA job and already stored test receipt without rerunning its command", async (t) => {
  const f = fixture(t);
  f.post();
  const [ready] = f.store.listQueuedHandoffs();
  f.store.claimHandoff(ready.id);
  f.store.bindNativeSession(f.owner, f.run.id, "qa", "existing-qa-session");
  f.store.markHandoffDispatched(ready.id);
  const { action } = f.store.beginDeliveryAction(ready.id, "test");
  f.store.finishDeliveryAction(action.id, {
    exitCode: 0,
    output: "pre-restart QA evidence",
  });
  f.store.finishTurn(f.owner, f.run.id, "qa", ready.requestId, {
    text: "Private pre-restart completion",
  });
  f.restart();
  await f.execution.recover();
  await until(() => f.view().status === "completed");
  assert.deepEqual(
    f.trace.commands.map((x) => x.op),
    ["deploy", "verify"],
  );
  assert.equal(f.trace.prompts.length, 1);
  assert.doesNotMatch(JSON.stringify(f.view()), /Private pre-restart/);
});
