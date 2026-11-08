import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWorkspace } from "./config.mjs";
import { StoreError } from "./store.mjs";

const helper = fileURLToPath(
  new URL("../scripts/role-action.mjs", import.meta.url),
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const invalid = (message) => new StoreError(400, "invalid_candidate", message);
const candidateLimit = 16 * 1024 * 1024;

export function targetStatePath(data, teamId, target) {
  return path.join(
    data,
    "delivery",
    "targets",
    sha(JSON.stringify([teamId, target])),
  );
}

function pathsInCandidate(files) {
  if (!Array.isArray(files) || !files.length || files.length > 128)
    throw invalid("候选应列出 1 至 128 个文件。");
  for (const file of files) {
    if (
      typeof file !== "string" ||
      file.length > 1024 ||
      /^[a-z]:/i.test(file) ||
      file.includes("\\") ||
      file.includes("\0") ||
      path.isAbsolute(file) ||
      file.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw invalid("候选文件须是工作目录中的明确相对路径。");
    }
  }
  if (new Set(files).size !== files.length)
    throw invalid("候选文件清单包含重复项。");
  return [...files].sort();
}

async function readManifest(root, files) {
  root = await realpath(root);
  const entries = [];
  let size = 0;
  for (const file of pathsInCandidate(files)) {
    const requested = path.join(root, file);
    if ((await realpath(requested)) !== requested)
      throw invalid("候选文件不能经过符号链接：" + file);
    const handle = await open(
      requested,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || size + stat.size > candidateLimit)
        throw invalid("候选只支持普通文件，合计最多 16 MiB。");
      const bytes = await handle.readFile();
      size += bytes.length;
      if (size > candidateLimit || bytes.length !== stat.size)
        throw invalid("候选在读取过程中发生变化或超过大小限制。");
      entries.push({ file, bytes, hash: sha(bytes) });
    } finally {
      await handle.close();
    }
  }
  return {
    entries,
    digest: sha(JSON.stringify(entries.map((e) => [e.file, e.hash]))),
  };
}

async function writeEntries(dir, entries) {
  for (const { file, bytes } of entries) {
    const target = path.join(dir, file);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  }
}

// A native agent sees a private grant-file path. Only the matching running
// job can start its preconfigured command. Neither argv nor cwd comes from it.
export function createDeliveryGate(store, { data, workspace, port }) {
  const root = path.join(data, "delivery");
  const snapshots = path.join(root, "snapshots"),
    grants = path.join(root, "grants");
  const active = new Map();
  let secretPromise;
  function secret() {
    if (!secretPromise)
      secretPromise = (async () => {
        await mkdir(root, { recursive: true, mode: 0o700 });
        const file = path.join(root, "capability.key");
        try {
          await writeFile(file, randomBytes(32), { flag: "wx", mode: 0o600 });
        } catch (e) {
          if (e.code !== "EEXIST") throw e;
        }
        return readFile(file);
      })();
    return secretPromise;
  }
  async function grantFor(jobId) {
    return createHmac("sha256", await secret())
      .update("delivery-job:" + jobId)
      .digest("hex");
  }

  async function capture(run, role) {
    const next = run.roles[run.roles.findIndex((n) => n.id === role.id) + 1];
    if (next?.delivery?.kind !== "qa") return null;
    const files = pathsInCandidate(next.delivery.files);
    const dir = resolveWorkspace(workspace, role.cwd);
    let snapshot;
    try {
      snapshot = await readManifest(dir, files);
    } catch (error) {
      if (error instanceof StoreError) throw error;
      throw invalid(
        "无法读取候选清单中的文件：" +
          (error.path ? path.basename(error.path) : "请检查目录"),
      );
    }
    await mkdir(snapshots, { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(path.join(snapshots, ".preparing-"));
    try {
      await writeEntries(staging, snapshot.entries);
      try {
        await rename(staging, path.join(snapshots, snapshot.digest));
      } catch (e) {
        if (!["ENOTEMPTY", "EEXIST"].includes(e.code)) throw e;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    return { digest: snapshot.digest, files };
  }

  async function instructions(job) {
    const work = store.getDeliveryJob(job.id);
    if (!work?.role?.delivery) return "";
    if (!work.candidate) throw invalid("交接缺少固定候选。");
    await mkdir(grants, { recursive: true, mode: 0o700 });
    const file = path.join(grants, job.id + ".json");
    const tmp = await mkdtemp(path.join(grants, ".new-"));
    try {
      const staged = path.join(tmp, "grant");
      await writeFile(
        staged,
        JSON.stringify({
          base: "http://127.0.0.1:" + port,
          jobId: job.id,
          token: await grantFor(job.id),
        }),
        { mode: 0o600 },
      );
      await rename(staged, file);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    const prefix = [process.execPath, helper, file].map(quote).join(" ");
    const isQa = work.role.delivery.kind === "qa";
    return [
      "这是团队配置的真实工具步骤。你必须通过自己的终端工具执行下面命令，等待实际输出，随后只向本人报告证据和结论。",
      "候选 SHA-256：" + work.candidate.digest,
      isQa
        ? "运行一次 QA 测试。失败时如实报告失败用例与预期/实际值，不要修改实现或测试；平台会带着失败回执退回开发。"
        : "部署到团队指定的测试环境 " +
          work.role.delivery.target +
          "，部署成功后运行 verify 检查该地址。部署或验证失败时停止，保留诊断。",
      ...(isQa ? [prefix + " test"] : [prefix + " deploy", prefix + " verify"]),
      "该 helper 只调用这个任务预先绑定的命令。请不要打印或读取凭据文件内容、绕过 helper 直接执行团队脚本、另起服务或自行伪造成功报告。",
    ].join("\n");
  }

  async function executeCommand(work, action, op) {
    const { candidate, role, job } = work;
    const target = targetStatePath(
      data,
      work.run.teamId,
      role.delivery.target || "qa",
    );
    const scratchRoot = path.join(root, "executions");
    await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
    const temp = await mkdtemp(path.join(scratchRoot, "command-"));
    try {
      const snap = await readManifest(
        path.join(snapshots, candidate.digest),
        candidate.files,
      );
      if (snap.digest !== candidate.digest)
        throw Error("候选快照内容校验失败。");
      await writeEntries(temp, snap.entries);
      await mkdir(target, { recursive: true, mode: 0o700 });
      const argv = action.argv;
      const env = {};
      for (const key of [
        "HOME",
        "PATH",
        "USER",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "SystemRoot",
      ])
        if (process.env[key]) env[key] = process.env[key];
      Object.assign(env, {
        OHOO_CANDIDATE_SHA256: candidate.digest,
        OHOO_CANDIDATE_FILES: JSON.stringify(candidate.files),
        OHOO_RUN_ID: job.runId,
        OHOO_OPERATION_ID: action.id,
        OHOO_ARTIFACT_ID: job.artifactId,
        OHOO_ARTIFACT_REVISION: String(job.revision),
        OHOO_TARGET: role.delivery.target || "qa",
        OHOO_RELEASE_STATE_DIR: target,
      });
      return await boundedCommand(argv, temp, env);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  async function invoke(jobId, op, token) {
    if (
      !/^[a-zA-Z0-9-]{1,128}$/.test(jobId) ||
      !["test", "deploy", "verify"].includes(op) ||
      !/^\w{64}$/.test(token || "") ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(await grantFor(jobId)))
    ) {
      throw new StoreError(403, "tool_forbidden", "工具授权无效。");
    }
    const { created, action } = store.beginDeliveryAction(jobId, op);
    if (!created) return active.get(action.id) || action;
    const work = store.getDeliveryJob(jobId);
    const promise = (async () => {
      try {
        const result = await executeCommand(work, action, op);
        if (result.unknown)
          return store.markDeliveryActionUnknown(action.id, result.output);
        return store.finishDeliveryAction(action.id, result);
      } catch (error) {
        return store.markDeliveryActionUnknown(
          action.id,
          String(error.message).slice(0, 2000),
        );
      }
    })();
    active.set(action.id, promise);
    try {
      return await promise;
    } finally {
      active.delete(action.id);
    }
  }
  return { capture, instructions, invoke };
}

function boundedCommand(argv, cwd, env) {
  const [program, ...args] = argv;
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(program === "node" ? process.execPath : program, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: grouped,
    });
    let tail = Buffer.alloc(0),
      total = 0,
      timedOut = false;
    const add = (chunk) => {
      total += chunk.length;
      tail = Buffer.concat([tail, chunk]).subarray(-24000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (grouped) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    }, 90000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      let output =
        (total > tail.length ? "[仅保留输出末尾]\n" : "") +
        tail.toString("utf8");
      if (signal || timedOut || code === null)
        output +=
          "\n命令未正常退出：" + (timedOut ? "超时" : signal || "退出码未知");
      resolve({
        exitCode: code,
        output,
        unknown: Boolean(signal || timedOut || code === null),
      });
    });
  });
}
