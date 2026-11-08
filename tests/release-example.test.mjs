import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const prepare = fileURLToPath(
  new URL("../scripts/prepare-release-example.mjs", import.meta.url),
);
const files = [
  "orders.mjs",
  "orders.test.mjs",
  "orders-http.mjs",
  "acceptance.test.mjs",
  "team-release.mjs",
  "test-environment.mjs",
].sort();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function digest(directory) {
  const entries = await Promise.all(
    files.map(async (file) => [
      file,
      sha(await readFile(join(directory, file))),
    ]),
  );
  return sha(JSON.stringify(entries));
}
async function node(args, cwd, extra = {}) {
  const env = { ...process.env, NODE_NO_WARNINGS: "1", ...extra };
  delete env.NODE_TEST_CONTEXT; // Launch an independent node --test runner.
  return exec(process.execPath, args, {
    cwd,
    timeout: 15000,
    env,
  });
}

test("team release deploys immutable files into an independently running loopback CSV service", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "ohoo-test-release-"));
  const work = join(scratch, "work"),
    state = join(scratch, "team-state");
  await mkdir(work);
  const runnerEnv = {
    OHOO_DATA_DIR: join(scratch, "app"),
    OHOO_WORKSPACE_ROOT: work,
    OHOO_RELEASE_STATE_DIR: state,
    OHOO_CANDIDATE_FILES: JSON.stringify(files),
    OHOO_RUN_ID: "test-run",
    OHOO_TARGET: "test-environment",
  };
  const snapshot = (await node([prepare], scratch, runnerEnv)).stdout.trim();
  const script = join(snapshot, "team-release.mjs");
  let cleanupScript = script;
  const cli = async (action, operation, cwd, entry = script, extra = {}) =>
    JSON.parse(
      (
        await node([entry, action], cwd, {
          ...runnerEnv,
          OHOO_OPERATION_ID: operation,
          ...extra,
        })
      ).stdout,
    );
  t.after(async () => {
    try {
      await cli("cleanup", "cleanup", scratch, cleanupScript);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
  assert.deepEqual((await readdir(snapshot)).sort(), files);
  const originalDigest = await digest(snapshot);
  const originalTests = await readFile(join(snapshot, "orders.test.mjs"));
  await assert.rejects(
    node(["--test", "orders.test.mjs", "acceptance.test.mjs"], snapshot),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /# pass 8/);
      assert.match(error.stdout, /# fail 1/);
      assert.match(error.stdout, /05,north,paid/);
      return true;
    },
  );

  // Model a developer fixing only the HTTP integration in this isolated test copy.
  const httpFile = join(snapshot, "orders-http.mjs");
  const before = await readFile(httpFile, "utf8");
  const corrected = before
    .replaceAll("listOrders", "exportOrderRows")
    .replace(
      "exportOrderRows(orders, query).items",
      "exportOrderRows(orders, query)",
    );
  assert.notEqual(corrected, before);
  await writeFile(httpFile, corrected);
  assert.deepEqual(
    await readFile(join(snapshot, "orders.test.mjs")),
    originalTests,
  );
  const fixedDigest = await digest(snapshot);
  assert.notEqual(originalDigest, fixedDigest);
  assert.match(
    (await node(["--test", "orders.test.mjs", "acceptance.test.mjs"], snapshot))
      .stdout,
    /# pass 9/,
  );
  runnerEnv.OHOO_CANDIDATE_SHA256 = fixedDigest;
  await assert.rejects(
    cli("deploy", "wrong-manifest", snapshot, script, {
      OHOO_CANDIDATE_SHA256: originalDigest,
    }),
    /snapshot differs/,
  );

  const [first, replay] = await Promise.all([
    cli("deploy", "deploy-one", snapshot),
    cli("deploy", "deploy-one", snapshot),
  ]);
  assert.deepEqual(first, replay);
  assert.equal(first.candidateDigest, fixedDigest);
  assert.equal(new URL(first.healthUrl).hostname, "127.0.0.1");
  const identity = async () =>
    (await (await fetch(first.url + "/_team/identity")).json()).instanceId;
  const serviceId = await identity();
  const verified = await cli("verify", "verify-one", snapshot);
  assert.equal(verified.url, first.url);
  assert.equal(
    verified.checks.find((c) => c.name === "anonymous denied").httpStatus,
    401,
  );
  assert.deepEqual(
    verified.checks.find((c) => c.name.startsWith("north:")).rows,
    ["id,account,status", "01,north,paid", "04,north,paid", "05,north,paid"],
  );
  assert.deepEqual(
    verified,
    JSON.parse(
      await readFile(
        join(state, "receipts", sha("verify-one") + ".json"),
        "utf8",
      ),
    ),
  );
  assert.deepEqual(await cli("verify", "verify-one", snapshot), verified);
  assert.equal(
    await identity(),
    serviceId,
    "a replay must not restart the listener",
  );
  assert.equal(JSON.stringify(verified).includes("Bearer"), false);

  const deployed = join(state, "candidates", fixedDigest);
  cleanupScript = join(deployed, "team-release.mjs");
  const anotherDeployment = await cli("deploy", "deploy-two", snapshot);
  assert.equal(anotherDeployment.url, first.url);
  assert.equal(
    await identity(),
    serviceId,
    "a new deploy of the same version must reuse the listener",
  );
  const tamperPath = join(deployed, "orders.mjs");
  const approvedOrders = await readFile(tamperPath);
  await chmod(tamperPath, 0o600);
  await writeFile(tamperPath, "// tampered release");
  await assert.rejects(
    cli("verify", "verify-tamper", snapshot),
    /persisted candidate differs/,
  );
  await writeFile(tamperPath, approvedOrders);
  await chmod(tamperPath, 0o400);
  await cli("cleanup", "stop-for-restart", snapshot);
  const restarted = await cli("deploy", "deploy-after-restart", snapshot);
  assert.equal(
    restarted.url,
    first.url,
    "the service must reopen its original port",
  );
  assert.notEqual(await identity(), serviceId);
  await rm(snapshot, { recursive: true, force: true });
  const health = await (await fetch(first.healthUrl)).json();
  assert.deepEqual(health, { status: "healthy", candidateDigest: fixedDigest });
  const csv = await fetch(first.exportUrl, {
    headers: { Authorization: "Bearer demo-north" },
  });
  assert.equal(csv.headers.get("x-candidate-sha256"), fixedDigest);
  assert.match(await csv.text(), /05,north,paid/);
  const status = await cli("status", "status-one", scratch, cleanupScript);
  assert.equal(status.online, true);
  const cleaned = await cli("cleanup", "cleanup-one", scratch, cleanupScript);
  assert.equal(cleaned.online, false);
  await assert.rejects(fetch(first.healthUrl));
  assert.equal(
    (await cli("cleanup", "cleanup-again", scratch, cleanupScript)).online,
    false,
  );

  // An unrelated process may reuse a stopped port. Never send that process a stop request.
  const observed = [];
  const foreign = createServer((req, res) => {
    observed.push([req.method, req.url, req.headers.authorization]);
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ instanceId: "someone-else" }));
  });
  foreign.listen(Number(new URL(first.url).port), "127.0.0.1");
  await once(foreign, "listening");
  try {
    assert.equal(
      (await cli("cleanup", "cleanup-foreign", scratch, cleanupScript)).online,
      false,
    );
    assert.deepEqual(observed, [["GET", "/_team/identity", undefined]]);
    assert.equal(foreign.listening, true);
  } finally {
    await new Promise((resolve) => foreign.close(resolve));
  }
});
