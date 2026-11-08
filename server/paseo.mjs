// Paseo 0.15.2 public SDK. A client connection owns no agent process:
// releasing it between HTTP requests leaves the daemon's agent available by ID.
import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPaseoClient } from "@getpaseo/client";

const running = new Map();
const turnTimeout = 120_000;

class PaseoError extends Error {
  constructor(code, message, statusCode = 503) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function publicFailure(error) {
  if (error instanceof PaseoError) return error;
  const detail = String(error?.message ?? error).toLowerCase();
  // Native diagnostics can contain CLI arguments, authorization headers or tool output.
  if (
    /unauthori|authenticat|invalid.api.key|login required|401|403/.test(detail)
  ) {
    return new PaseoError(
      "paseo_auth",
      "Paseo 或所选执行器需要有效的本机登录。",
    );
  }
  if (/timeout|timed out|deadline/.test(detail)) {
    return new PaseoError(
      "paseo_timeout",
      "Paseo 请求超时，请核对原会话状态。",
      504,
    );
  }
  if (/socket|connect|disconnect|transport|econnrefused/.test(detail)) {
    return new PaseoError(
      "paseo_connection",
      "无法连接 Paseo daemon，请检查本机实例。",
    );
  }
  return new PaseoError(
    "paseo_error",
    "Paseo 操作未成功，请检查该会话或所选执行器。",
  );
}

async function withClient(operation) {
  const client = createPaseoClient({
    url: process.env.OHOO_PASEO_URL || "ws://127.0.0.1:6767/ws",
    password: process.env.OHOO_PASEO_PASSWORD || undefined,
    clientId: "ohoo-" + randomUUID(),
    connectTimeoutMs: 5_000,
    reconnect: { enabled: false },
  });
  try {
    await client.connect();
    return await operation(client);
  } catch (error) {
    throw publicFailure(error);
  } finally {
    await client.close().catch(() => {});
  }
}

async function directory(cwd) {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new PaseoError("invalid_cwd", "请选择绝对路径的工作目录。", 400);
  }
  const path = await realpath(cwd).catch(() => null);
  if (!path || !(await stat(path)).isDirectory()) {
    throw new PaseoError("invalid_cwd", "所选工作目录不存在。", 400);
  }
  return path;
}

async function providerRows(client, cwd) {
  const snapshot = await client.providers.waitForReady({
    cwd,
    timeoutMs: 15_000,
  });
  return snapshot.entries
    .filter((row) => row.enabled)
    .map((row) => ({
      id: row.provider,
      label: row.label || row.provider,
      status: row.status,
      available: row.status === "ready" && Boolean(row.models?.length),
      models: (row.models || []).map((model) => ({
        id: model.id,
        label: model.label || model.id,
        isDefault: Boolean(model.isDefault),
      })),
    }));
}

export async function listProviders(cwd) {
  const path = await directory(cwd);
  return withClient((client) => providerRows(client, path));
}

// This module is server-side. The HTTP caller must authenticate ownership of its
// own ohoo session record before resolving its stored agent ID.
async function ownedHandle(client, agentId) {
  const handle = client.agents.ref(agentId);
  let snapshot;
  try {
    snapshot = (await handle.refresh())?.agent;
  } catch (error) {
    if (/agent[^\n]*not found|unknown agent/i.test(String(error?.message)))
      return null;
    throw error;
  }
  if (!snapshot) return null;
  if (snapshot.labels?.source !== "ohoo") {
    throw new PaseoError("foreign_session", "该会话不属于 ohoo。", 403);
  }
  return handle;
}

function uuidFromKey(key) {
  const hex = createHash("sha256")
    .update("ohoo/paseo/" + key)
    .digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "5" + hex.slice(13, 16),
    "8" + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}

export async function createSession({
  provider,
  model,
  cwd,
  instructions = "",
  idempotencyKey,
  agentId,
}) {
  const path = await directory(cwd);
  if (
    !provider ||
    typeof provider !== "string" ||
    typeof instructions !== "string"
  ) {
    throw new PaseoError(
      "invalid_binding",
      "请选择执行器并提供有效的角色指令。",
      400,
    );
  }
  const key = idempotencyKey || agentId || randomUUID();
  const id = agentId || uuidFromKey(key);
  const definition = createHash("sha256")
    .update(JSON.stringify([provider, model || null, path, instructions]))
    .digest("hex");
  return withClient(async (client) => {
    const previous = await ownedHandle(client, id);
    if (previous) {
      const state = previous.current();
      if (state.labels.ohooDefinition !== definition) {
        throw new PaseoError(
          "create_conflict",
          "同一会话标识已用于另一组执行配置。",
          409,
        );
      }
      return {
        agentId: id,
        workspaceId: state.workspaceId,
        provider: state.provider,
        model: state.model,
        cwd: state.cwd,
      };
    }
    const available = (await providerRows(client, path)).find(
      (p) => p.id === provider && p.available,
    );
    if (!available)
      throw new PaseoError(
        "provider_unavailable",
        "所选执行器在该工作目录尚未就绪。",
        409,
      );
    const choice = model
      ? available.models.find((m) => m.id === model)
      : available.models.find((m) => m.isDefault) || available.models[0];
    if (!choice)
      throw new PaseoError("unknown_model", "该执行器没有报告所选模型。", 400);
    const handle = await client.agents.create({
      agentId: id,
      idempotencyKey: key,
      cwd: path,
      title: "ohoo · 角色会话",
      labels: { source: "ohoo", ohooDefinition: definition },
      config: {
        provider: provider + "/" + choice.id,
        systemPrompt: instructions || undefined,
      },
      // No initial prompt. A turn begins only when sendTurn sends user input.
    });
    return {
      agentId: handle.id,
      workspaceId: handle.workspaceId,
      provider,
      model: choice.id,
      cwd: path,
    };
  });
}

function agentStatus(snapshot) {
  if (snapshot.pendingPermissions?.length) return "permission";
  if (snapshot.status === "error" || snapshot.status === "closed")
    return "error";
  if (
    snapshot.status === "running" ||
    snapshot.status === "initializing" ||
    snapshot.activeTurn
  )
    return "running";
  return snapshot.status === "idle" ? "idle" : "unknown";
}

function result(agentId, messageId, status, extra = {}) {
  return {
    agentId,
    messageId: messageId || null,
    turnId: null,
    status,
    accepted: null,
    text: "",
    error: null,
    ...extra,
  };
}

// Resolve the specific client message and stop at the next user input. The
// global wait RPC's lastMessage can be the preceding turn, even when idle.
async function findTurn(handle, messageId) {
  let newerPrefix = [];
  let cursor;
  let epoch;
  do {
    const page = await handle.timeline.refetch({
      direction: cursor ? "before" : "tail",
      cursor,
      limit: 100,
      projection: "projected",
    });
    if (
      page.error ||
      page.staleCursor ||
      page.gap ||
      (epoch && epoch !== page.epoch)
    ) {
      return { complete: false };
    }
    epoch = page.epoch;
    const relevant = page.entries.filter((e) =>
      ["user_message", "assistant_message", "error"].includes(e.item.type),
    );
    const index = relevant.findIndex(
      (e) =>
        e.item.type === "user_message" &&
        (e.item.clientMessageId ?? e.item.messageId) === messageId,
    );
    if (index >= 0) {
      const user = relevant[index];
      const later = [...relevant.slice(index + 1), ...newerPrefix];
      const boundary = later.findIndex((e) => e.item.type === "user_message");
      const segment = (boundary < 0 ? later : later.slice(0, boundary)).filter(
        (e) => user.turnId && e.turnId === user.turnId,
      );
      return {
        complete: true,
        user,
        followed: boundary >= 0,
        reply:
          segment.findLast((e) => e.item.type === "assistant_message")?.item
            .text || "",
        error: segment.findLast((e) => e.item.type === "error")?.item.message,
      };
    }
    if (!page.hasOlder) return { complete: true };
    // Once we cross a user entry, anything after it cannot belong to the
    // message on the preceding page. Keep only one potentially split turn.
    const firstUser = relevant.findIndex((e) => e.item.type === "user_message");
    newerPrefix =
      firstUser < 0
        ? [...relevant, ...newerPrefix]
        : relevant.slice(0, firstUser + 1);
    if (!page.startCursor || page.startCursor.seq === cursor?.seq)
      return { complete: false };
    cursor = page.startCursor;
  } while (cursor);
  return { complete: false };
}

async function inspect(handle, messageId) {
  const turn = await findTurn(handle, messageId);
  const state = handle.current();
  if (!turn.user)
    return { observation: result(handle.id, messageId, "unknown"), turn };
  const detail = { accepted: true, turnId: turn.user.turnId || null };
  const status = turn.followed ? "idle" : agentStatus(state);
  if (turn.error || status === "error") {
    return {
      observation: result(handle.id, messageId, "error", {
        ...detail,
        error: publicFailure(turn.error || state.lastError || "provider error")
          .message,
      }),
      turn,
    };
  }
  if ((status === "idle" || turn.followed) && (!detail.turnId || !turn.reply)) {
    return {
      observation: result(handle.id, messageId, "unknown", detail),
      turn,
    };
  }
  return {
    observation: result(handle.id, messageId, status, {
      ...detail,
      text: status === "idle" ? turn.reply : "",
    }),
    turn,
  };
}

export async function observeSession(agentId, { messageId } = {}) {
  return withClient(async (client) => {
    const handle = await ownedHandle(client, agentId);
    if (!handle) return result(agentId, messageId, "not_found");
    if (!messageId) return result(agentId, null, agentStatus(handle.current()));
    return (await inspect(handle, messageId)).observation;
  });
}

async function executeTurn(agentId, text, { messageId, timeoutMs, onEvent }) {
  const notify = (type, fields = {}) =>
    onEvent?.({ type, agentId, messageId, ...fields });
  return withClient(async (client) => {
    const handle = await ownedHandle(client, agentId);
    if (!handle)
      throw new PaseoError("session_not_found", "Paseo 会话不存在。", 404);
    const prior = await inspect(handle, messageId);
    if (prior.turn.user && prior.turn.user.item.text !== text) {
      throw new PaseoError(
        "turn_conflict",
        "同一消息标识已用于不同内容。",
        409,
      );
    }
    if (!prior.turn.complete) return prior.observation;
    if (prior.turn.user && prior.observation.status !== "running")
      return prior.observation;
    let accepted = Boolean(prior.turn.user);
    if (!accepted && agentStatus(handle.current()) !== "idle") {
      throw new PaseoError(
        "session_busy",
        "该会话仍在执行或等待处理，请先核对当前回合。",
        409,
      );
    }
    const expires = Date.now() + timeoutMs;
    try {
      if (!accepted) {
        await handle.send(text, { messageId });
        accepted = true;
      }
      notify("accepted");
      notify("status", { status: "running" });
      while (Date.now() < expires) {
        const waited = await handle.waitForFinish(
          Math.max(1, expires - Date.now()),
        );
        const { observation } = await inspect(handle, messageId);
        if (observation.status === "idle") {
          notify("assistant", {
            text: observation.text,
            turnId: observation.turnId,
          });
          return observation;
        }
        if (["permission", "error"].includes(observation.status))
          return observation;
        if (
          ["permission", "error"].includes(waited.status) &&
          !observation.turnId
        ) {
          // No reliable native turn identity is available for the daemon-level
          // permission/failure. Leave the caller a recoverable unresolved turn.
          return result(agentId, messageId, "unknown", {
            accepted,
            error: "Paseo 回合需要处理，但尚未取得匹配的回合记录。",
          });
        }
        if (waited.status === "timeout") break;
        // The wait RPC may observe idle before the submitted turn starts.
        await delay(Math.min(250, Math.max(0, expires - Date.now())));
      }
      return result(agentId, messageId, "timeout", {
        accepted,
        error: "等待已超时；请按原消息标识核对，Paseo 回合可能仍在运行。",
      });
    } catch (error) {
      // A dropped acknowledgement does not establish that sending failed.
      return result(agentId, messageId, "unknown", {
        accepted: accepted || null,
        error: publicFailure(error).message,
      });
    }
  });
}

export async function sendTurn(
  agentId,
  text,
  { onEvent, messageId = randomUUID(), timeoutMs = turnTimeout } = {},
) {
  if (
    typeof text !== "string" ||
    !text.trim() ||
    typeof messageId !== "string" ||
    !messageId ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new PaseoError(
      "invalid_turn",
      "请提供消息正文、消息标识和有效等待时间。",
      400,
    );
  }
  const active = running.get(agentId);
  if (active) {
    if (active.messageId === messageId && active.text === text)
      return active.promise;
    throw new PaseoError("session_busy", "该会话正在处理另一条消息。", 409);
  }
  const promise = executeTurn(agentId, text, { messageId, timeoutMs, onEvent });
  running.set(agentId, { messageId, text, promise });
  try {
    return await promise;
  } finally {
    running.delete(agentId);
  }
}
