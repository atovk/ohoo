import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const files = [
  "orders.mjs",
  "orders.test.mjs",
  "orders-http.mjs",
  "acceptance.test.mjs",
  "team-release.mjs",
  "test-environment.mjs",
].sort();
const fileHash = (value) => createHash("sha256").update(value).digest("hex");
function checksum(directory) {
  const manifest = files.map((file) => {
    const path = join(directory, file);
    if (!lstatSync(path).isFile())
      throw Error("candidate file is not a regular file: " + file);
    return [file, fileHash(readFileSync(path))];
  });
  return fileHash(JSON.stringify(manifest));
}
function readOptional(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function saveJson(file, value) {
  const next = file + "." + randomUUID();
  writeFileSync(next, JSON.stringify(value) + "\n", { mode: 0o600 });
  renameSync(next, file);
}
function required(name) {
  if (!process.env[name]?.trim()) throw Error(name + " is required");
  return process.env[name];
}
async function endpoint(state) {
  const record = readOptional(join(state, "endpoint.json"));
  if (!record) return null;
  assert.ok(
    Number.isInteger(record.port) && record.port > 0 && record.port < 65536,
    "invalid saved port",
  );
  const url = `http://127.0.0.1:${record.port}`;
  try {
    const response = await fetch(url + "/_team/identity", {
      signal: AbortSignal.timeout(700),
    });
    if (response.ok && (await response.json()).instanceId === record.instanceId)
      return { ...record, url };
  } catch {}
  return null;
}
async function ensureServer(state, candidate) {
  const live = await endpoint(state);
  if (live) return live;
  const log = openSync(join(state, "service.log"), "a", 0o600);
  let child;
  try {
    child = spawn(
      process.execPath,
      [join(candidate, "test-environment.mjs"), state],
      {
        cwd: state,
        detached: true,
        stdio: ["ignore", log, log],
        env: { PATH: process.env.PATH || "", NODE_NO_WARNINGS: "1" },
      },
    );
    child.unref();
  } finally {
    closeSync(log);
  }
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    await delay(40);
    const ready = await endpoint(state);
    if (ready) return ready;
  }
  throw Error(
    "test environment did not become ready on its assigned port; see service.log",
  );
}
function materialize(state, source, digest) {
  const root = join(state, "candidates");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = join(root, digest);
  if (!existsSync(dir)) {
    const staging = mkdtempSync(join(root, ".stage-"));
    try {
      for (const file of files) {
        copyFileSync(join(source, file), join(staging, file));
        chmodSync(join(staging, file), 0o400);
      }
      assert.equal(
        checksum(staging),
        digest,
        "candidate changed during the copy",
      );
      renameSync(staging, dir);
    } finally {
      rmSync(staging, { force: true, recursive: true });
    }
  }
  assert.equal(
    checksum(dir),
    digest,
    "persisted candidate differs from its certified digest",
  );
  return dir;
}
async function checkHealth(url, digest) {
  const response = await fetch(url + "/health", {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(
    response.status,
    200,
    "health endpoint returned " + response.status,
  );
  const result = await response.json();
  assert.equal(result.status, "healthy");
  assert.equal(
    result.candidateDigest,
    digest,
    "health returned a different candidate",
  );
  return result;
}
async function verifyCsv(url, digest) {
  const checks = [];
  const columns = "id,account,status";
  for (const [name, token, query, expected] of [
    ["anonymous denied", null, "status=paid", null],
    [
      "north: all pages sorted",
      "demo-north",
      "status=paid&account=south",
      [columns, "01,north,paid", "04,north,paid", "05,north,paid"],
    ],
    [
      "south: isolated account",
      "demo-south",
      "status=paid&account=north",
      [columns, "02,south,paid"],
    ],
    ["empty filter", "demo-north", "status=refunded", [columns]],
  ]) {
    const response = await fetch(url + "/orders.csv?" + query, {
      headers: token ? { Authorization: "Bearer " + token } : {},
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, token ? 200 : 401, name);
    if (expected) {
      assert.match(
        response.headers.get("content-type") || "",
        /^text\/csv/,
        name,
      );
      assert.equal(response.headers.get("x-candidate-sha256"), digest, name);
      const rows = (await response.text()).trimEnd().split(/\r?\n/);
      assert.deepEqual(rows, expected, name);
      checks.push({ name, httpStatus: response.status, rows });
    } else {
      await response.text();
      checks.push({ name, httpStatus: response.status });
    }
  }
  return checks;
}
async function run(state, action) {
  const activeFile = join(state, "active.json");
  const active = readOptional(activeFile);
  if (action === "status" || action === "cleanup") {
    const live = await endpoint(state);
    if (action === "cleanup" && live) {
      const response = await fetch(live.url + "/_team/stop", {
        method: "POST",
        headers: { Authorization: "Bearer " + live.controlToken },
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(response.status, 200);
      await response.text();
      const deadline = Date.now() + 3000;
      while (await endpoint(state)) {
        if (Date.now() > deadline) throw Error("service did not stop");
        await delay(40);
      }
    }
    return {
      action,
      online: action === "status" && !!live,
      url: live?.url ?? null,
      deployment: active,
    };
  }
  if (!["deploy", "verify"].includes(action))
    throw Error("usage: node team-release.mjs deploy|verify|status|cleanup");
  const digest = required("OHOO_CANDIDATE_SHA256");
  const listed = JSON.parse(required("OHOO_CANDIDATE_FILES"));
  assert.deepEqual(listed, files, "unexpected candidate file list");
  assert.match(digest, /^[a-f\d]{64}$/);
  assert.equal(
    checksum(process.cwd()),
    digest,
    "snapshot differs from its certified digest",
  );
  const operationId = required("OHOO_OPERATION_ID"),
    runId = required("OHOO_RUN_ID"),
    target = required("OHOO_TARGET");
  const receipts = join(state, "receipts");
  mkdirSync(receipts, { recursive: true, mode: 0o700 });
  const receiptFile = join(receipts, fileHash(operationId) + ".json");
  const previous = readOptional(receiptFile);
  if (previous) {
    assert.deepEqual(
      [
        previous.operationId,
        previous.runId,
        previous.target,
        previous.action,
        previous.candidateDigest,
      ],
      [operationId, runId, target, action, digest],
      "operation id reused for a different action or candidate",
    );
    return previous;
  }
  const dir = join(state, "candidates", digest);
  let service,
    health,
    checks = [];
  if (action === "deploy") {
    materialize(state, process.cwd(), digest);
    service = await ensureServer(state, dir);
    saveJson(activeFile, {
      candidateDigest: digest,
      operationId,
      runId,
      target,
    });
    try {
      health = await checkHealth(service.url, digest);
    } catch (error) {
      if (active) saveJson(activeFile, active);
      else rmSync(activeFile, { force: true });
      throw error;
    }
  } else {
    assert.ok(
      active && active.candidateDigest === digest && active.target === target,
      "target has no matching deployed candidate",
    );
    assert.equal(
      checksum(dir),
      digest,
      "persisted candidate differs from its certified digest",
    );
    service = await endpoint(state);
    if (!service) throw Error("deployed test environment is offline");
    health = await checkHealth(service.url, digest);
    checks = await verifyCsv(service.url, digest);
  }
  const receipt = {
    operationId,
    runId,
    target,
    action,
    candidateDigest: digest,
    url: service.url,
    healthUrl: service.url + "/health",
    exportUrl: service.url + "/orders.csv?status=paid",
    timestamp: new Date().toISOString(),
    health,
    checks,
  };
  saveJson(receiptFile, receipt);
  return receipt;
}
async function main() {
  const state = required("OHOO_RELEASE_STATE_DIR");
  if (!isAbsolute(state))
    throw Error("OHOO_RELEASE_STATE_DIR must be absolute");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(join(state, "release-lock.sqlite"));
  try {
    lock.exec("PRAGMA busy_timeout=15000; BEGIN IMMEDIATE");
    console.log(JSON.stringify(await run(state, process.argv[2])));
  } finally {
    lock.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
