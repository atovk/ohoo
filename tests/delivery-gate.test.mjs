import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createAuth } from "../server/auth.mjs";
import { createStore } from "../server/store.mjs";
import { createDeliveryGate } from "../server/delivery-gate.mjs";
import { createExecution } from "../server/execution.mjs";
import { createHttpService } from "../server/http.mjs";

test("agent tools run configured commands on sealed bytes, retry a failed candidate and reuse release receipts", async (t) => {
  const data = await realpath(
    await mkdtemp(path.join(tmpdir(), "ohoo-action-api-")),
  );
  const work = await mkdtemp(path.join(data, "project-"));
  const files = ["app.txt", "actions.mjs"],
    script = `
    import {readFileSync,writeFileSync} from 'node:fs';import path from 'node:path';
    const op=process.argv[2], value=readFileSync('app.txt','utf8');
    const deployed=path.join(process.env.OHOO_RELEASE_STATE_DIR,'deployed');
    if(op==='test' && value!=='fixed')process.exitCode=1;
    if(op==='deploy')writeFileSync(deployed,process.env.OHOO_CANDIDATE_SHA256);
    if(op==='verify' && readFileSync(deployed,'utf8')!==process.env.OHOO_CANDIDATE_SHA256)process.exitCode=1;
    console.log(op,value,process.env.OHOO_CANDIDATE_SHA256);
  `;
  await writeFile(path.join(work, "app.txt"), "bug");
  await writeFile(path.join(work, "actions.mjs"), script);
  const store = createStore(),
    auth = createAuth(data);
  const owner = store.owner(),
    priv = "private model reply",
    invocations = [];
  const runtime = {
    async createSession({ agentId }) {
      return { agentId };
    },
    async sendTurn(agentId, input) {
      const commands = [
        ...input.matchAll(
          /^'([^'\n]+)' '([^'\n]+)' '([^'\n]+\.json)' (test|deploy|verify)$/gm,
        ),
      ];
      invocations.push(commands.map((m) => m[4]));
      if (!commands.length)
        await writeFile(path.join(work, "app.txt"), "fixed");
      for (const [, node, helper, grant, op] of commands) {
        const call = async () => {
          const child = spawn(node, [helper, grant, op], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", (b) => (output += b));
          child.stderr.on("data", (b) => (output += b));
          const [code] = await once(child, "close");
          return { code, output };
        };
        const first = await call(),
          replay = await call();
        assert.deepEqual(replay, first);
        assert.match(first.output, /ohoo (test|deploy|verify) ·/);
      }
      return { status: "idle", accepted: true, text: priv };
    },
  };
  let gate;
  const adapter = {
    capture: (...a) => gate.capture(...a),
    instructions: (...a) => gate.instructions(...a),
    invoke: (...a) => gate.invoke(...a),
  };
  const execution = createExecution(store, runtime, work, adapter);
  const server = createHttpService({
    store,
    auth,
    execution,
    runtime,
    workspace: work,
    gate: adapter,
  });
  t.after(async () => {
    execution.stop();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    auth.close();
    await rm(data, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  gate = createDeliveryGate(store, { workspace: work, data, port });
  const base = {
    kind: "agent",
    assigneeId: owner.id,
    provider: "test",
    cwd: work,
    environmentId: "local",
    autoStartOnHandoff: true,
    duty: "测试",
    output: "产物",
  };
  const team = store.createTeam(owner.id, {
    name: "自定义交付",
    roles: [
      { ...base, id: "dev", name: "开发" },
      {
        ...base,
        id: "qa",
        name: "质量",
        delivery: {
          kind: "qa",
          files,
          test: ["node", "actions.mjs", "test"],
          maxRepairs: 1,
        },
      },
      {
        ...base,
        id: "sre",
        name: "发布",
        delivery: {
          kind: "release",
          target: "test",
          deploy: ["node", "actions.mjs", "deploy"],
          verify: ["node", "actions.mjs", "verify"],
        },
      },
    ],
  });
  const run = store.startRun(owner.id, team.id, { title: "传递候选" });
  const candidate = await gate.capture(run, run.roles[0]);
  // The mutable workspace changes after submission; QA must still test the frozen v1 bytes.
  await writeFile(path.join(work, "app.txt"), "another value");
  store.submitArtifact(
    owner.id,
    run.id,
    "dev",
    {
      requestId: "req",
      body: "测试第一版",
      summary: "请在封存候选上运行团队测试",
    },
    candidate,
  );
  await execution.wake();
  let result;
  for (let i = 0; i < 140; i++) {
    result = store.getRun(owner.id, run.id);
    if (result.deliveryBlock || result.status === "completed") break;
    await delay(50);
  }
  assert.equal(
    result.status,
    "completed",
    JSON.stringify(result.deliveryBlock),
  );
  assert.deepEqual(invocations, [["test"], [], ["test"], ["deploy", "verify"]]);
  const actions = result.deliveryActions;
  assert.deepEqual(
    actions.map((a) => [a.op, a.exitCode]),
    [
      ["test", 1],
      ["test", 0],
      ["deploy", 0],
      ["verify", 0],
    ],
  );
  assert.match(actions[0].output, /test bug /);
  assert.notEqual(actions[0].candidate.digest, actions[1].candidate.digest);
  assert.equal(actions[1].candidate.digest, actions[2].candidate.digest);
  assert.equal(actions[2].candidate.digest, actions[3].candidate.digest);
  assert.ok(result.artifacts.every((a) => !JSON.stringify(a).includes(priv)));
  const forged = await fetch(
    `http://127.0.0.1:${port}/api/role-actions/${actions[0].jobId}/test`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + "a".repeat(64),
      },
      body: "{}",
    },
  );
  assert.equal(forged.status, 403);
});

test("sealing rejects traversal and linked inputs without reading outside the configured workspace", async () => {
  const data = await realpath(await mkdtemp(path.join(tmpdir(), "ohoo-seal-")));
  const work = await mkdtemp(path.join(data, "work-"));
  try {
    await writeFile(path.join(data, "private"), "not candidate material");
    await symlink(path.join(data, "private"), path.join(work, "link"));
    const gate = createDeliveryGate({}, { data, workspace: work, port: 0 });
    for (const file of ["../private", "link"]) {
      const dev = { id: "d", cwd: work },
        qa = { id: "q", delivery: { kind: "qa", files: [file] } };
      await assert.rejects(gate.capture({ roles: [dev, qa] }, dev), {
        code: "invalid_candidate",
      });
    }
    assert.equal(
      await readFile(path.join(data, "private"), "utf8"),
      "not candidate material",
    );
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});
