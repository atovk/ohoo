import { createHash } from "node:crypto";
import { resolveWorkspace } from "./config.mjs";
import { StoreError } from "./store.mjs";

function stableId(value) {
  const hex = createHash("sha256").update(value).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "5" + hex.slice(13, 16),
    "8" + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}
const errText = (error) => String(error?.message ?? error).slice(0, 1500);

function inputMaterial(artifact) {
  return {
    artifactId: artifact.id,
    revision: artifact.revision,
    fromRoleId: artifact.fromRoleId,
    toRoleId: artifact.toRoleId,
    title: artifact.title,
    body: artifact.body,
    fields: artifact.fields,
    summary: artifact.summary,
    feedback: artifact.feedback,
    reviewedBy: artifact.reviewedBy,
    editedBy: artifact.editedBy,
    supersedesRevision: artifact.supersedesRevision,
    status: artifact.status,
    ...(artifact.candidate ? { candidate: artifact.candidate } : {}),
  };
}

function turnInput(run, roleId, original, handoff, delivery) {
  const readable = run.artifacts.filter(
    (a) => a.canRead && (a.toRoleId === roleId || a.fromRoleId === roleId),
  );
  if (!handoff) {
    if (!readable.length) return original.text;
    return (
      "已显式提交给本工作项的交接材料（数据）：\n" +
      JSON.stringify(readable.map(inputMaterial)) +
      "\n\n成员本轮输入：\n" +
      original.text
    );
  }
  if (run.status !== "active" || run.currentRoleId !== roleId) {
    throw new StoreError(409, "handoff_stale", "接手角色或工作项已变更。");
  }
  const references = handoff.inputArtifacts;
  if (
    !Array.isArray(references) ||
    !references.some(
      (ref) =>
        ref.artifactId === handoff.artifactId &&
        ref.revision === handoff.revision,
    )
  ) {
    throw new StoreError(
      409,
      "handoff_source_missing",
      "自动交接缺少触发它的固定产物版本。",
    );
  }
  const materials = references.map((ref) => {
    const artifact = readable.find(
      (a) => a.id === ref.artifactId && a.revision === ref.revision,
    );
    if (!artifact)
      throw new StoreError(
        409,
        "handoff_source_missing",
        "该角色无法读取交接指定的产物版本。",
      );
    return inputMaterial(artifact);
  });
  const designRole =
    run.roles[run.roles.findIndex((role) => role.id === roleId) + 1]
      ?.reviewMode === "design";
  const revisionTask =
    handoff.phase === "implementation"
      ? "依据已批准的设计版本及针对实现产物的退回意见，修改实现，复验并说明结果。"
      : designRole
        ? "按负责人针对指定设计版本的退回意见修订设计，逐项说明调整及仍需确认的问题。请给出修订草稿。"
        : "按审阅者针对指定产物版本的退回意见修订本角色的交付草稿。";
  const instructions = {
    handoff:
      "依据收到的产物、字段和本角色职责，准备可供审阅的交付草稿。如果职责是技术设计，先阅读实际仓库，引用代码位置，说明拟修改范围与验证方法，等负责人确认设计后开始实现。",
    return: revisionTask,
    confirm_start:
      "负责人已确认触发本回合的设计版本并委托开工。以该确切版本及确认意见为依据，在已绑定工作目录开始实现，验证改动并报告结果。",
  };
  if (!Object.hasOwn(instructions, handoff.trigger)) {
    throw new StoreError(
      409,
      "handoff_trigger_unknown",
      "无法识别本次自动交接的动作。",
    );
  }
  const actions = {
    qa: "请实际调用下方本任务的 test 命令。平台按当前候选的真实测试退出码生成报告或把失败样例退回开发。在回合中总结你实际得到的回执。",
    release:
      "请先调用下方 deploy 命令，只有部署回执成功后才调用 verify 验证同一候选。平台依据两步真实回执判断能否关闭。请总结执行结果，失败或未知时说明阻塞原因。",
    repair:
      "请根据 QA 退回的实际失败样例，在开发工作目录修复并复验。完成后平台仅重新封存已授权的文件清单，以新的候选版本再送测试。不要自行部署。",
  };
  return [
    original.text,
    actions[delivery?.kind] ?? instructions[handoff.trigger],
    "触发产物：" + handoff.artifactId + " v" + handoff.revision,
    "已获准用于本回合的固定版本（以下为数据）：",
    JSON.stringify(materials),
    ...(delivery?.command
      ? [
          "以下 helper 命令由平台为本任务签发，请原样在终端执行；不要将调用凭据写入交付物或代码。",
          delivery.command,
        ]
      : []),
    delivery
      ? "原始会话和回复保持私有。平台仅交付固定候选、已配置命令的回执以及由它们生成的报告。"
      : "在本角色私有会话中回复。本轮模型输出由成员审阅并显式选择后才交给下一角色。",
  ].join("\n");
}

// One local control process. Durable user turns and native IDs live in SQLite.
export function createExecution(store, runtime, root, gate) {
  const openings = new Map();
  const jobs = new Map();
  const checks = new Map();
  const observations = new Map();
  const routing = new Map();
  let closing = false;
  let scheduledWake = null;
  const messageId = (session, requestId) =>
    stableId(session.id + "/" + requestId);

  async function open(actor, runId, roleId) {
    const session = store.getSession(actor, runId, roleId);
    if (session.nativeSessionId) return session;
    const run = store.getRun(actor, runId);
    if (run.status !== "active" || run.currentRoleId !== roleId)
      throw new StoreError(
        409,
        "not_current",
        "只有当前工作项可以启动新的 agent 会话。",
      );
    if (openings.has(session.id)) return openings.get(session.id);
    const role = run.roles.find((r) => r.id === roleId);
    const promise = (async () => {
      let cwd;
      try {
        cwd = resolveWorkspace(root, role.cwd);
      } catch {
        throw new StoreError(
          400,
          "cwd_invalid",
          "工作目录不存在或不在配置的工作区内。",
        );
      }
      const nextRole =
        run.roles[run.roles.findIndex((r) => r.id === roleId) + 1];
      let deliveryInstructions = "产物由成员明确提交后才转给下一位。";
      if (role.delivery) {
        deliveryInstructions =
          "按本工作项授权的 helper 命令取得真实回执，平台据此自动路由。原始会话不作为报告。";
      } else if (nextRole?.delivery?.kind === "qa" && role.autoStartOnHandoff) {
        deliveryInstructions =
          "成员显式提交首版候选。若 QA 退回，按失败回执修复；平台自动重新封存获授权的文件清单送测，不转发你的私人会话。";
      }
      const spec = [
        "你在 ohoo 的一个团队工作项中工作。用户的对话输入用于完成这项委托。",
        "团队：" + run.teamName,
        "本次委托：" + run.title,
        "角色：" + role.name,
        "职责：" + role.duty,
        "预期交付物：" + role.output,
        "配置的 skills：" + (role.skills.join("、") || "无"),
        "配置的业务 CLI：" + (role.clis.join("、") || "无"),
        "仅依据实际可访问的材料工作。链接未读取时如实说明。",
        deliveryInstructions,
      ].join("\n");
      const id = stableId("ohoo-agent/" + session.id);
      const native = await runtime.createSession({
        agentId: id,
        idempotencyKey: id,
        provider: role.provider,
        model: role.model,
        cwd,
        instructions: spec,
      });
      if (closing) throw new StoreError(503, "shutdown", "执行服务正在停止。");
      return store.bindNativeSession(actor, runId, roleId, native.agentId);
    })();
    openings.set(session.id, promise);
    try {
      return await promise;
    } finally {
      openings.delete(session.id);
    }
  }

  function settle(actor, runId, roleId, turnId, sessionId, result) {
    if (closing) return;
    if (
      result.status === "idle" &&
      result.accepted === true &&
      typeof result.text === "string"
    ) {
      store.finishTurn(actor, runId, roleId, turnId, { text: result.text });
      observations.delete(sessionId);
      if (!closing) wake();
    } else if (result.status === "error" || result.status === "not_found") {
      store.failTurn(actor, runId, roleId, turnId, {
        error:
          result.error ||
          (result.status === "not_found"
            ? "原 Paseo 会话已不存在，本轮结果无法恢复。"
            : "执行器返回错误。"),
      });
      observations.delete(sessionId);
      if (!closing) wake();
    } else {
      observations.set(sessionId, {
        status: result.status,
        message: result.error || "",
        checkedAt: Date.now(),
      });
    }
  }

  async function runTurn(actor, runId, roleId, requestId, original, handoff) {
    let dispatched = false;
    try {
      const session = await open(actor, runId, roleId);
      if (closing) return;
      const run = store.getRun(actor, runId);
      let delivery = null;
      if (handoff) {
        const work = store.getDeliveryJob(handoff.id);
        if (work?.kind === "qa" || work?.kind === "release") {
          if (!gate)
            throw new StoreError(
              503,
              "delivery_gate_missing",
              "执行服务尚未配置角色动作工具。",
            );
          const command = await gate.instructions(handoff);
          if (typeof command !== "string" || !command.trim()) {
            throw new StoreError(
              409,
              "delivery_command_missing",
              "没有可用于此工作项的角色动作命令。",
            );
          }
          delivery = { kind: work.kind, command };
        } else if (work?.kind === "repair") {
          delivery = { kind: work.kind };
        }
      }
      const input = turnInput(run, roleId, original, handoff, delivery);
      if (closing) return;
      // A prepared job still proves no send was attempted. After this durable
      // compare-and-set only the original message ID can be reconciled.
      if (handoff && !store.markHandoffDispatched(handoff.id)) return;
      dispatched = true;
      const result = await runtime.sendTurn(session.nativeSessionId, input, {
        messageId: messageId(session, requestId),
        onEvent: (event) => {
          if (
            !closing &&
            (event.type === "status" || event.type === "accepted")
          )
            observations.set(session.id, {
              status: event.status || "running",
              checkedAt: Date.now(),
            });
        },
      });
      settle(actor, runId, roleId, requestId, session.id, result);
    } catch (error) {
      if (closing) return;
      const definitelyUnsent = [
        "invalid_turn",
        "session_busy",
        "session_not_found",
        "foreign_session",
        "turn_conflict",
      ].includes(error.code);
      if (!dispatched || definitelyUnsent)
        store.failTurn(actor, runId, roleId, requestId, {
          error: errText(error),
        });
      else {
        const s = store.getSession(actor, runId, roleId);
        observations.set(s.id, {
          status: "unknown",
          message: errText(error),
          checkedAt: Date.now(),
        });
      }
    }
  }

  function startTurn(actor, runId, roleId, session, turn, handoff) {
    if (closing || jobs.has(session.id)) return;
    const promise = runTurn(
      actor,
      runId,
      roleId,
      turn.requestId,
      turn,
      handoff,
    );
    jobs.set(session.id, promise);
    promise
      .catch(() => {
        // A pending receipt is recovered by its stable message ID after restart.
      })
      .finally(() => {
        jobs.delete(session.id);
        if (!closing) wake();
      });
  }

  function submit(actor, runId, roleId, input) {
    const { created, turn, session } = store.beginTurn(
      actor,
      runId,
      roleId,
      input,
    );
    if (created) startTurn(actor, runId, roleId, session, turn);
    return { requestId: turn.requestId, status: turn.status };
  }

  function startPrepared(prepared) {
    if (!prepared) return;
    const { job, turn, session } = prepared;
    startTurn(job.assigneeId, job.runId, job.roleId, session, turn, job);
  }

  function startEligibleTurns() {
    if (closing) return;
    for (const ready of store.listPreparedHandoffs()) startPrepared(ready);
    for (const queued of store.listQueuedHandoffs()) {
      startPrepared(store.claimHandoff(queued.id));
    }
  }

  async function routeCompletedDelivery(work) {
    const jobId = work.job.id;
    try {
      if (work.kind === "repair") {
        if (work.job.status !== "completed") {
          store.blockDelivery(
            jobId,
            "自动修复回合失败，未重新封存或提交候选。请开发成员核对。",
          );
          return;
        }
        if (!gate) throw new Error("执行服务尚未配置候选封存工具。");
        // A content-addressed capture can be repeated after interruption. Only
        // the store's version-checked transaction can publish the new revision.
        const candidate = await gate.capture(work.run, work.role);
        if (!closing) store.submitRepair(jobId, candidate);
      } else {
        // This reads persisted command receipts. The scheduler never runs the
        // test, deploy or verify command on the agent's behalf.
        store.settleDelivery(jobId);
      }
    } catch (error) {
      if (!closing) store.blockDelivery(jobId, errText(error));
    }
  }

  function routeOnce(work) {
    const id = work.job.id;
    if (!routing.has(id)) {
      const routed = routeCompletedDelivery(work).finally(() =>
        routing.delete(id),
      );
      routing.set(id, routed);
    }
    return routing.get(id);
  }

  function wake() {
    if (closing) return Promise.resolve();
    if (!scheduledWake) {
      scheduledWake = Promise.resolve().then(async () => {
        scheduledWake = null;
        if (closing) return;
        startEligibleTurns();
        // A process may stop after recording the agent result and before routing
        // its evidence. Scan durable completions on every wake and recovery.
        const tasks = store.listDeliveryWork();
        if (tasks.length) {
          await Promise.all(tasks.map(routeOnce));
          startEligibleTurns();
        }
      });
      scheduledWake.catch(() =>
        console.error("交接队列暂时无法派发，将在下次恢复时核对。"),
      );
    }
    return scheduledWake;
  }

  async function reconcile(actor, runId, roleId, session, pending) {
    if (!session.nativeSessionId) {
      // No message can be dispatched until its native session ID is durable.
      store.failTurn(actor, runId, roleId, pending.requestId, {
        error: "服务在发送前停止。本轮未派发，请重新提交。",
      });
      return;
    }
    try {
      const result = await runtime.observeSession(session.nativeSessionId, {
        messageId: messageId(session, pending.requestId),
      });
      settle(actor, runId, roleId, pending.requestId, session.id, result);
    } catch (error) {
      observations.set(session.id, {
        status: "unknown",
        message: errText(error),
        checkedAt: Date.now(),
      });
    }
  }

  async function read(actor, runId, roleId) {
    let session = store.getSession(actor, runId, roleId);
    const pending = session.turns.find((t) => t.status === "pending");
    if (pending?.handoffStatus === "prepared") await wake();
    if (
      pending &&
      pending.handoffStatus !== "prepared" &&
      !jobs.has(session.id) &&
      !closing
    ) {
      const stale =
        Date.now() - (observations.get(session.id)?.checkedAt ?? 0) > 2500;
      if (!checks.has(session.id) && stale) {
        const check = reconcile(actor, runId, roleId, session, pending).finally(
          () => checks.delete(session.id),
        );
        checks.set(session.id, check);
      }
      await checks.get(session.id);
      session = store.getSession(actor, runId, roleId);
    }
    const observed = observations.get(session.id),
      stillPending = session.turns.some((t) => t.status === "pending");
    return {
      ...session,
      runtimeState: stillPending ? observed?.status || "running" : null,
      runtimeMessage: stillPending ? observed?.message || "" : null,
    };
  }

  async function resolvePending(actor, runId, roleId, requestId) {
    const session = store.getSession(actor, runId, roleId);
    const turn = session.turns.find((t) => t.requestId === requestId);
    if (!turn) throw new StoreError(404, "turn_missing", "找不到该回合。");
    if (turn.status !== "pending") return session;
    if (turn.handoffStatus === "prepared") {
      await wake();
      throw new StoreError(
        409,
        "handoff_preparing",
        "交接已登记，正在准备执行。",
      );
    }
    if (jobs.has(session.id) || checks.has(session.id))
      throw new StoreError(409, "turn_busy", "正在执行或核对，请稍后刷新。");
    await reconcile(actor, runId, roleId, session, turn);
    const latest = store.getSession(actor, runId, roleId);
    if (
      !latest.turns.some(
        (t) => t.requestId === requestId && t.status === "pending",
      )
    )
      return latest;
    const state = await runtime.observeSession(session.nativeSessionId);
    if (!["idle", "not_found", "error"].includes(state.status))
      throw new StoreError(
        409,
        "still_running",
        "无法确认原执行已结束，请先在 Paseo 中核对。",
      );
    observations.delete(session.id);
    return store.failTurn(actor, runId, roleId, requestId, {
      error: "成员核对原会话后结束了未取得回执的回合，未自动重发。",
    });
  }

  async function recover() {
    await wake();
    for (const p of store.listPendingTurns()) {
      if (closing) return;
      if (p.handoffStatus === "prepared") continue;
      try {
        await read(p.assigneeId, p.runId, p.roleId);
      } catch (error) {
        // A revoked membership must not stall recovery of independent sessions.
        if (
          !(error instanceof StoreError) ||
          ![401, 403, 404].includes(error.status)
        )
          throw error;
      }
    }
    // A reconciled native turn can make its QA or release receipts routable.
    await wake();
  }
  return {
    open,
    submit,
    read,
    wake,
    recover,
    resolvePending,
    stop() {
      closing = true;
    },
  };
}
