import React, { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCheck,
  ChevronRight,
  Circle,
  Clock3,
  FileCheck2,
  FileText,
  GitBranch,
  History,
  Layers3,
  LockKeyhole,
  MessageSquare,
  Play,
  Plus,
  Route,
} from "lucide-react";
import {
  useStudio,
  uid,
  clone,
  Button,
  Modal,
  Field,
  Badge,
  addEvent,
  advance,
} from "./studio";
import { RunMap } from "./RunMap";
import "./runs.css";

const stageNames = {
  intake: "需求确认",
  dev: "技术设计",
  lead: "方案确认",
  peer: "专项评审",
  impl: "开发实现",
  qa: "预发验证",
  sre: "生产发布",
  sign: "交付验收",
};
const toneFor = (status) =>
  status === "已完成" || status === "已签收"
    ? "green"
    : status === "已退回"
      ? "red"
      : status === "等待人工" || status === "待签收"
        ? "amber"
        : "blue";
const when = (value) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "";
const currentNode = (r) => r.nodes.find((n) => n.id === r.current);
const byAction = (r, action) =>
  r.nodes.find((n) => (n.action || n.id) === action);
const lastOf = (items, predicate) => [...items].reverse().find(predicate);
const candidate = (r) => `RC-${r.candidate || 1}`;
const defaultDecision =
  "导出全部筛选结果，沿用订单列表的权限与排序。授权账号命中 43 条时导出 43 条，受限账号仅可导出可见订单。";
const technicalDraft = (r) =>
  `目标：${r.title}\n\n需求依据：${r.decision || "D-01 · " + defaultDecision}\n仓库依据（模拟）：src/orders/query.ts 的 listOrders 复用账号权限与排序；src/orders/export.ts 当前只处理一页。\n\n计划：沿用 listOrders 的授权查询，逐页读取结果并写入 CSV。\n验证：以每页 20 条、命中 43 条的样例覆盖第二页与受限账号。${r.feedback ? "\n修订依据：" + r.feedback : ""}`;
const sampleRepro =
  "预发复现：按订单状态筛选，当前页 20 条、命中 43 条。导出后预期 43 条，实际 20 条。请覆盖第二页并重跑权限用例。";

function evidence(
  r,
  node,
  actor,
  {
    title,
    body,
    toId = "",
    summary = "",
    status = "已签收",
    rev = 1,
    fields = {},
  },
) {
  const previousPlan =
    fields.type === "design" && lastOf(r.artifacts, (a) => isPlan(r, a));
  const item = {
    id: previousPlan?.id || uid(),
    rev,
    nodeId: node.id,
    toId,
    title,
    body,
    summary,
    fields,
    status,
    actor,
  };
  r.artifacts.push(item);
  return item;
}
function finish(r, n, text, actor) {
  r.status = "已完成";
  addEvent(r, n.id, text, actor);
}
function target(r, n, action, text, actor) {
  const next = byAction(r, action);
  if (!next) {
    addEvent(
      r,
      n.id,
      `交接等待配置：流程 v${r.version} 缺少“${stageNames[action] || action}”。`,
      actor,
    );
    return;
  }
  advance(r, next.id, text, actor);
}
function isPlan(r, a) {
  return (
    a.fields?.type === "design" ||
    (a.nodeId === byAction(r, "dev")?.id &&
      a.toId === byAction(r, "lead")?.id &&
      a.title?.includes("技术方案"))
  );
}
function latestPlan(r) {
  return lastOf(
    r.artifacts,
    (a) => isPlan(r, a) && a.rev === (r.design?.rev || 1),
  );
}
function isReadable(r, a, user) {
  return (
    a.actor === user ||
    r.nodes.some(
      (n) => n.owner === user && (n.id === a.nodeId || n.id === a.toId),
    )
  );
}
function versionKey(a) {
  return a.id + "@" + a.rev;
}
function pendingInput(r, n) {
  return lastOf(
    r.artifacts,
    (item) =>
      item.toId === n.id &&
      item.status === "待签收" &&
      !r.artifacts.some(
        (newer) => newer.id === item.id && Number(newer.rev) > Number(item.rev),
      ),
  );
}
function keepPlan(r, n, actor) {
  let kept = latestPlan(r);
  if (kept) return kept;
  const source = byAction(r, "dev") || n;
  return evidence(r, source, actor, {
    title: "技术方案",
    rev: r.design.rev || 1,
    body: r.design.body || technicalDraft(r),
    toId: n.id,
    status: "待签收",
    fields: { type: "design" },
  });
}
function optionsFor(run, node) {
  const action = node.action || node.id,
    rc = candidate(run),
    phase = run.rollout?.phase || "待放行",
    designVersion = `v${run.design?.rev || 1}`;
  switch (action) {
    case "intake":
      if (run.productQuestion)
        return [
          {
            id: "keepScope",
            label: "确认原预期，继续修复",
            primary: true,
            form: "产品确认原预期",
            field: "既定行为与验证样例",
            value: run.decision || defaultDecision,
          },
          {
            id: "newScope",
            label: "修改业务范围，重新设计",
            form: "产品变更需求范围",
            field: "新的业务决定与验收条件",
          },
        ];
      return [
        {
          id: "scope",
          label: "确认范围，交给开发",
          primary: true,
          form: "确认需求范围",
          field: "业务决定与验收样例",
          value: run.decision || defaultDecision,
        },
      ];
    case "dev":
      return [
        {
          id: "design",
          label: run.feedback ? "提交修订方案" : "提交设计方案",
          primary: true,
          form: "提交技术方案",
          field: "方案正文",
          value: technicalDraft(run),
        },
      ];
    case "lead":
      return [
        {
          id: "edit",
          label: "直接改稿",
          form: `编辑技术方案 ${designVersion}`,
          field: "方案正文",
          value: run.design?.body || technicalDraft(run),
        },
        {
          id: "direct",
          label: "确认并开工",
          primary: true,
          disabled: !!run.design?.requirePeer,
        },
        { id: "review", label: "送专项评审" },
        {
          id: "rejectPlan",
          label: "退回修改",
          form: "退回技术方案",
          field: "请作者修改什么",
        },
      ];
    case "peer":
      return [
        { id: "peerOK", label: "评审通过，交给开发", primary: true },
        {
          id: "rejectPlan",
          label: "附意见退回",
          form: "专项评审意见",
          field: "需解决的问题",
        },
      ];
    case "impl":
      return [
        {
          id: "build",
          label: `提交 ${run.rebuild ? `RC-${(run.candidate || 1) + 1}` : rc} 送测`,
          primary: true,
        },
        {
          id: "scopeChanged",
          label: "接口变化，转设计",
          form: "升级到设计复核",
          field: "接口或技术方案发生了什么变化",
        },
        {
          id: "askProduct",
          label: "预期有争议，请产品决定",
          form: "提交业务问题",
          field: "产品负责人需要决定什么",
        },
      ];
    case "qa":
      return [
        { id: "qaOK", label: `签收 ${rc}`, primary: true },
        {
          id: "localBug",
          label: "退回局部缺陷",
          form: `退回 ${rc} 的局部缺陷`,
          field: "预期、实际与复现步骤",
          value: sampleRepro,
        },
        {
          id: "scopeChanged",
          label: "接口变化，转设计",
          form: "升级到设计复核",
          field: "接口影响与复现依据",
        },
        {
          id: "askProduct",
          label: "预期有争议，请产品决定",
          form: "提交业务问题",
          field: "产品负责人需要决定什么",
        },
      ];
    case "sre": {
      if (phase === "灰度中")
        return [
          { id: "full", label: "灰度健康，开始全量", primary: true },
          {
            id: "rollback",
            label: "指标异常，停止放量并回滚",
            form: `回滚 ${rc}`,
            field: "异常指标与止损原因",
            value:
              "灰度窗口内错误率超出发布策略阈值。停止扩量，切回上一个稳定版本。",
          },
        ];
      if (phase === "全量观察")
        return [
          { id: "healthy", label: "确认全量健康，送验收", primary: true },
          {
            id: "rollback",
            label: "服务异常，回滚",
            form: `回滚 ${rc}`,
            field: "异常指标与止损原因",
            value: "全量观察中出现服务异常，切回上一个稳定版本。",
          },
        ];
      if (phase === "回滚中" || phase === "等待值班确认")
        return [
          { id: "recover", label: "确认已恢复，退回修复", primary: true },
          {
            id: "unknown",
            label: "恢复待值班核对",
            disabled: phase === "等待值班确认",
          },
        ];
      return [{ id: "canary", label: `放行 ${rc} 并开始灰度`, primary: true }];
    }
    case "sign":
      return [
        {
          id: "tech",
          label: "核验技术证据",
          primary: !run.technicalSign,
          disabled: !!run.technicalSign,
        },
        {
          id: "business",
          label: "签收业务样例并完成",
          primary: !!run.technicalSign,
          disabled: !run.technicalSign,
        },
        {
          id: "businessFail",
          label: "样例失败，退回修复",
          form: "线上业务样例失败",
          field: "失败样例与线上影响",
        },
      ];
    default:
      return [];
  }
}

function applyDelivery(r, n, id, body, actor) {
  const rc = candidate(r),
    ownerFor = (a) => byAction(r, a)?.id || "",
    go = (a, text) => target(r, n, a, text, actor),
    event = (text) => addEvent(r, n.id, text, actor);
  const record = (title, content, extra = {}) =>
    evidence(r, n, actor, { title, body: content, ...extra });
  const plan = r.design || { rev: 0, body: "", route: "" };
  r.design = plan;
  switch (id) {
    case "askProduct":
      r.productQuestion = body;
      r.rebuild = r.rebuild || n.action === "qa";
      r.qaSign = "";
      r.healthy = "";
      r.technicalSign = false;
      record("待澄清的预期", body, {
        toId: ownerFor("intake"),
        fields: { type: "question", candidate: rc },
      });
      go("intake", "预期行为有争议，等待产品负责人澄清。");
      r.status = "等待人工";
      break;
    case "keepScope":
    case "newScope": {
      const changed = id === "newScope";
      r.decision = body;
      r.productQuestion = "";
      r.feedback = changed
        ? "产品决定已更新，请按新验收条件修订方案。"
        : "产品确认既定行为，依据原缺陷记录继续修复。";
      record("产品澄清记录", body, {
        toId: ownerFor(changed ? "dev" : "impl"),
        fields: { type: "decision", candidate: rc },
      });
      go(changed ? "dev" : "impl", r.feedback);
      break;
    }
    case "scope":
      r.decision = body;
      record("D-01 · 需求确认", body, {
        toId: ownerFor("dev"),
        fields: { type: "decision" },
      });
      go("dev", "确认 D-01，开发收到验收样例与需求依据。");
      break;
    case "design": {
      const previous = lastOf(r.artifacts, (a) => isPlan(r, a));
      plan.rev = previous ? Math.max(plan.rev || 1, previous.rev || 1) + 1 : 1;
      plan.body = body;
      plan.route = "";
      r.feedback = "";
      record("技术方案", body, {
        rev: plan.rev,
        toId: ownerFor("lead"),
        status: "待签收",
        fields: { type: "design" },
      });
      go("lead", `提交技术方案 v${plan.rev}，等待开发负责人审阅。`);
      break;
    }
    case "edit": {
      const previous = keepPlan(r, n, actor);
      if (previous.status === "待签收") previous.status = "已取代";
      plan.rev = (plan.rev || 1) + 1;
      plan.body = body;
      plan.route = "";
      record("技术方案", body, {
        rev: plan.rev,
        toId: n.id,
        status: "待签收",
        fields: { type: "design" },
      });
      event(`开发负责人直接改稿，保存技术方案 v${plan.rev}。`);
      break;
    }
    case "direct":
    case "review":
    case "peerOK": {
      const item = keepPlan(r, n, actor);
      item.status = "已签收";
      const peer = id === "review";
      plan.route = peer ? "专项评审" : "直接开发";
      plan.requirePeer = peer;
      record(
        id === "peerOK" ? "专项评审结论" : "方案确认记录",
        `已确认技术方案 v${plan.rev || 1}。${peer ? "提交专项评审。" : "允许开发依据此版本实现。"}`,
        {
          rev: plan.rev || 1,
          toId: ownerFor(peer ? "peer" : "impl"),
          fields: { type: "designApproval", designRevision: plan.rev || 1 },
        },
      );
      go(
        peer ? "peer" : "impl",
        `技术方案 v${plan.rev || 1} ${peer ? "已送专项评审" : id === "peerOK" ? "专项评审通过，进入实现" : "由开发负责人确认，直接开工"}。`,
      );
      break;
    }
    case "rejectPlan": {
      keepPlan(r, n, actor).status = "已退回";
      r.feedback = body;
      plan.requirePeer = (n.action || n.id) === "peer" || plan.requirePeer;
      record("设计修改意见", body, {
        rev: plan.rev || 1,
        toId: ownerFor("dev"),
        status: "已退回",
        fields: { type: "review" },
      });
      go("dev", `退回技术方案 v${plan.rev || 1}：${body}`);
      break;
    }
    case "build": {
      if (r.rebuild) r.candidate = (r.candidate || 1) + 1;
      const next = candidate(r);
      r.rebuild = false;
      r.technicalSign = false;
      r.qaSign = "";
      r.healthy = "";
      r.rollout = { phase: "待放行" };
      const basis = lastOf(r.artifacts, (a) => isPlan(r, a))
        ? `方案 v${plan.rev || 1}`
        : "已确认的局部缺陷与复现样例";
      record(
        `${next} · 候选制品`,
        `模拟 CI 构建成功。实现依据：${basis}。\n变更：逐页读取符合权限与排序条件的订单。\n自测：跨页导出、受限账号样例通过。`,
        { toId: ownerFor("qa"), fields: { type: "build", candidate: next } },
      );
      go("qa", `实现和模拟构建完成，${next} 交给 QA 预发验证。`);
      break;
    }
    case "qaOK":
      r.qaSign = rc;
      record(
        `${rc} · 预发测试报告`,
        "模拟预发结果：授权账号 43/43；受限账号仅导出可见订单。",
        { toId: ownerFor("sre"), fields: { type: "qa", candidate: rc } },
      );
      go("sre", `QA 已签收 ${rc}，产物及预发证据已交给 SRE。`);
      break;
    case "localBug":
    case "scopeChanged": {
      r.rebuild =
        r.rebuild ||
        n.action === "qa" ||
        !!lastOf(r.artifacts, (a) => a.fields?.type === "build");
      r.feedback = body;
      r.qaSign = "";
      r.healthy = "";
      r.technicalSign = false;
      const dest = id === "localBug" ? "impl" : "dev";
      record(id === "localBug" ? `${rc} · 缺陷复现` : "范围变更依据", body, {
        toId: ownerFor(dest),
        status: "已退回",
        fields: { type: "defect", candidate: rc },
      });
      go(
        dest,
        id === "localBug"
          ? `${rc} 的可复现局部缺陷退回开发直接修复：${body}`
          : `接口或范围改变，转技术设计复核：${body}`,
      );
      break;
    }
    case "canary":
      if (
        r.qaSign !== rc &&
        !lastOf(
          r.artifacts,
          (a) =>
            a.fields?.type === "qa" &&
            a.fields.candidate === rc &&
            a.status === "已签收",
        )
      ) {
        event(`${rc} 尚缺同版本的预发签收。`);
        break;
      }
      r.rollout = { phase: "灰度中", candidate: rc };
      record(
        `${rc} · 生产放行`,
        `生产环境；候选 ${rc}；已核对预发签收并开始模拟灰度。`,
        {
          fields: { type: "release", candidate: rc, environment: "production" },
        },
      );
      event(`${rc} 获准在生产环境灰度，等待观察。`);
      break;
    case "full":
      r.rollout.phase = "全量观察";
      event(`${rc} 灰度观察通过，已开始全量部署。`);
      break;
    case "healthy":
      r.rollout.phase = "全量健康";
      r.healthy = rc;
      record(
        `${rc} · 全量健康报告`,
        "模拟全量观察窗口通过，生产版本与 QA 签收版本一致。",
        { toId: ownerFor("sign"), fields: { type: "health", candidate: rc } },
      );
      go("sign", `${rc} 全量健康，提交技术证据与线上业务样例。`);
      break;
    case "rollback":
      r.rollout.phase = "回滚中";
      r.feedback = body;
      r.healthy = "";
      r.technicalSign = false;
      record(`${rc} · 回滚记录`, body, {
        fields: { type: "rollback", candidate: rc },
      });
      event(`${rc} 已停止放量并发起回滚，等待恢复验证。`);
      break;
    case "unknown":
      r.rollout.phase = "等待值班确认";
      r.status = "等待人工";
      event("恢复情况待值班人员确认，发布保持打开。");
      break;
    case "recover":
      r.rollout.phase = "已恢复";
      r.rebuild = true;
      r.qaSign = "";
      r.healthy = "";
      record(
        `${rc} · 恢复验证`,
        "模拟稳定版本已恢复；此前版本的签收与放行保留在历史。",
        { toId: ownerFor("impl"), fields: { type: "recovery", candidate: rc } },
      );
      go("impl", `${rc} 回滚后已验证恢复，原需求退回开发修复。`);
      break;
    case "tech":
      if (r.healthy !== rc || r.qaSign !== rc) {
        event(`技术核验等待 ${rc} 的预发签收及生产健康报告。`);
        break;
      }
      r.technicalSign = rc;
      record(
        `${rc} · 技术核验`,
        "QA 签收版本、生产部署版本与全量健康报告均已核对。",
        { fields: { type: "technicalSignoff", candidate: rc } },
      );
      event(`${rc} 技术证据已核验，等待线上业务签收。`);
      break;
    case "business":
      if (r.technicalSign !== rc) return;
      record(`${rc} · 业务签收`, r.decision || defaultDecision, {
        fields: { type: "businessSignoff", candidate: rc },
      });
      finish(
        r,
        n,
        `${rc} 技术验收通过，线上导出与权限样例已签收，运行完成。`,
        actor,
      );
      break;
    case "businessFail":
      r.feedback = body;
      r.rebuild = true;
      r.technicalSign = false;
      record(`${rc} · 业务复验意见`, body, {
        toId: ownerFor("impl"),
        status: "已退回",
        fields: { type: "businessFailure", candidate: rc },
      });
      go("impl", `线上业务样例未通过，保留当前线上版本，退回修复：${body}`);
      break;
  }
}

function genericActions(r, n) {
  const item = pendingInput(r, n);
  if (item) {
    const review = [
      { id: "accept", label: `签收 v${item.rev}`, primary: true },
    ];
    if (n.kind === "human")
      review.push({
        id: "rewrite",
        label: "编辑当前稿件",
        form: `编辑 ${item.title} v${item.rev}`,
        field: "稿件正文",
        value: item.body,
      });
    review.push({
      id: "return",
      label: "附意见退回",
      form: "退回产物",
      field: "需要补充或修改的内容",
    });
    return review;
  }
  if (r.edges.some((edge) => edge.from === n.id)) return [];
  return [
    {
      id: "final",
      label: "提交最终产物",
      form: "提交最终产物",
      primary: true,
      disabled: r.artifacts.some((a) => a.status === "待签收"),
    },
  ];
}
function applyGeneric(r, n, id, body, actor) {
  if (id === "final") {
    if (
      r.edges.some((e) => e.from === n.id) ||
      r.artifacts.some((a) => a.status === "待签收") ||
      !body?.confirmed ||
      !body.title?.trim() ||
      !body.body?.trim()
    )
      return;
    const required = [...new Set(n.fields || [])];
    if (required.some((key) => !body.fields?.[key]?.trim())) return;
    evidence(r, n, actor, {
      title: body.title.trim(),
      body: body.body.trim(),
      fields: body.fields,
      toId: n.id,
      summary: `${actor} 确认完成条件：${r.finish}`,
    });
    finish(
      r,
      n,
      `${actor} 提交最终产物《${body.title.trim()}》v1，确认团队完成条件并归档。`,
      actor,
    );
    return;
  }
  const item = pendingInput(r, n);
  if (!item) return;
  if (id === "rewrite") {
    const revised = {
      ...clone(item),
      id: item.id,
      rev: (item.rev || 1) + 1,
      body,
      actor,
      summary: `${actor} 在 v${item.rev} 上改稿。`,
      fields: { ...item.fields, priorRevision: item.id },
    };
    item.status = "已取代";
    r.artifacts.push(revised);
    addEvent(
      r,
      n.id,
      `编辑《${item.title}》并保存 v${revised.rev}，请签收新版。`,
      actor,
    );
    return;
  }
  if (id === "return") {
    item.status = "已退回";
    item.review = body;
    advance(
      r,
      item.nodeId,
      `退回《${item.title}》v${item.rev}：${body}`,
      actor,
    );
    return;
  }
  item.status = "已签收";
  item.signedBy = actor;
  const message = `${actor} 签收《${item.title}》v${item.rev}。`;
  if (r.edges.some((e) => e.from === n.id)) {
    addEvent(r, n.id, message + " 当前角色可从会话提交自己的产物。", actor);
  } else if (!r.artifacts.some((a) => a.status === "待签收")) {
    finish(r, n, message + " 已达到团队完成条件。", actor);
  } else {
    addEvent(r, n.id, message + " 等待其余交付件签收。", actor);
  }
}
function describeStage(r, n) {
  const rc = candidate(r),
    action = n.action || n.id;
  if (r.template !== "delivery") return n.duty;
  const desc = {
    intake: r.productQuestion
      ? "等待产品决定：" + r.productQuestion
      : "确认本次委托的业务范围和可复验的样例，再将 D-01 交给开发。",
    dev: r.feedback
      ? `需按上轮意见修订：${r.feedback}`
      : "根据 D-01 和仓库中的订单查询、CSV 写入器编写方案，提交给开发负责人。",
    lead: `审阅技术方案 v${r.design?.rev || 1}。可直接改正文再确认，或将当前版交给专项评审。`,
    peer: `评审技术方案 v${r.design?.rev || 1} 的接口影响；通过后交给开发，退回时附具体意见。`,
    impl:
      r.feedback ||
      (r.type === "bug"
        ? "从已确认的复现样例直接修复。涉及共享接口或预期发生变化时交回设计。"
        : "依据确认方案实现变更，模拟构建候选制品并送交预发。"),
    qa: `核对 ${rc} 的跨页导出及权限样例。失败时带复现信息退回实现，接口变化时转设计复核。`,
    sre: `${rc} · ${r.rollout?.phase || "待放行"}。每次放量、回滚及恢复结果都会写入当前运行。`,
    sign: `核对 ${rc} 的 QA 签收、全量健康记录和线上业务样例，两项签收完成后关闭本次运行。`,
  };
  return desc[action] || n.duty;
}
function ProgressRail({ r, t }) {
  const { user, nav } = useStudio();
  const used = new Set(r.history.map((e) => e.nodeId)),
    delivery = r.template === "delivery";
  const visible = delivery
    ? r.nodes.filter(
        (n) => n.action !== "peer" || used.has(n.id) || n.id === r.current,
      )
    : r.nodes;
  return (
    <div className="run-rail" aria-label="流程进度">
      {visible.map((n) => {
        const here = n.id === r.current && r.status !== "已完成",
          done = used.has(n.id) && !here;
        return (
          <div
            key={n.id}
            className={"run-stage " + (here ? "here" : done ? "done" : "")}
            aria-current={here ? "step" : undefined}
          >
            <i>
              {here ? (
                <Play size={10} fill="currentColor" />
              ) : done ? (
                <Check size={13} />
              ) : (
                <Circle size={7} />
              )}
            </i>
            <span>
              {n.kind === "agent" &&
              n.owner === user &&
              (used.has(n.id) || here) ? (
                <button
                  type="button"
                  className="run-stage-link"
                  title={"进入" + n.name + "角色会话"}
                  onClick={() =>
                    nav("session", {
                      teamId: t.id,
                      runId: r.id,
                      nodeId: n.id,
                      tab: "from-run",
                    })
                  }
                >
                  {delivery ? stageNames[n.action] || n.name : n.name}
                  <ArrowUpRight size={10} />
                </button>
              ) : delivery ? (
                stageNames[n.action] || n.name
              ) : (
                n.name
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
function EvidenceCard({ items, choose }) {
  return (
    <section className="run-card">
      <header className="run-card-head">
        <div className="run-hgroup">
          <FileCheck2 size={17} />
          <h2>交付件与证据</h2>
        </div>
        <Badge>{items.length}</Badge>
      </header>
      {!items.length ? (
        <p className="run-note">角色提交产物后，可在这里查看版本与签收记录。</p>
      ) : (
        [...items].reverse().map((a) => (
          <button
            type="button"
            key={versionKey(a)}
            className="run-evidence"
            onClick={() => choose(a)}
          >
            <span className="run-evidence-icon">
              <FileText size={16} />
            </span>
            <span className="run-evidence-text">
              <strong>{a.title}</strong>
              <small>
                v{a.rev} · {a.status}
                {a.actor ? " · " + a.actor : ""}
              </small>
            </span>
            <ChevronRight size={14} />
          </button>
        ))
      )}
    </section>
  );
}
function EvidenceModal({ a, close }) {
  const visibleFields = Object.entries(a.fields || {}).filter(
    ([key]) =>
      ![
        "type",
        "priorRevision",
        "candidate",
        "environment",
        "designRevision",
      ].includes(key),
  );
  return (
    <Modal title={`${a.title} · v${a.rev}`} onClose={close}>
      <div className="run-mod-fields">
        <div className="run-meta">
          <Badge tone={toneFor(a.status)}>{a.status}</Badge>
          <span>{a.actor}</span>
        </div>
        <div className="run-preview-body">{a.body || "无正文"}</div>
        {a.summary && <p className="run-note">{a.summary}</p>}
        {visibleFields.map(([k, v]) => (
          <div key={k}>
            <strong>{k}</strong>
            <p className="run-preview-body">{String(v)}</p>
          </div>
        ))}
        {a.review && <div className="run-inset">退回意见 · {a.review}</div>}
      </div>
    </Modal>
  );
}
function Timeline({ r }) {
  const { user } = useStudio();
  return (
    <section className="run-card">
      <header className="run-card-head">
        <div className="run-hgroup">
          <History size={17} />
          <h2>运行时间线</h2>
        </div>
        <Badge>{r.history.length} 条记录</Badge>
      </header>
      <ol className="run-time-list">
        {[...r.history].reverse().map((ev) => (
          <li className="run-time-entry" key={ev.id}>
            <i />
            <div>
              <p>
                {r.nodes.some((n) => n.id === ev.nodeId && n.owner === user) ||
                ev.actor === user
                  ? ev.text
                  : "相关角色已更新工作记录。"}
              </p>
              <small>
                {when(ev.time)} · {ev.actor} ·{" "}
                {r.nodes.find((n) => n.id === ev.nodeId)?.name || "运行"}
              </small>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
function ActionPrompt({ option, onSubmit, onClose }) {
  const [body, setBody] = useState(option.value || "");
  return (
    <Modal title={option.form} onClose={onClose}>
      <form
        className="run-mod-fields"
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) onSubmit(body.trim());
        }}
      >
        <Field label={option.field}>
          <textarea
            autoFocus
            rows={8}
            required
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={option.field}
          />
        </Field>
        <div className="dialog-actions">
          <Button onClick={onClose}>取消</Button>
          <Button type="submit" variant="primary" disabled={!body.trim()}>
            {option.id === "edit" || option.id === "rewrite"
              ? "保存新版"
              : option.label}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function FinalArtifactPrompt({ r, n, onSubmit, onClose }) {
  const [title, setTitle] = useState(n.output || ""),
    [body, setBody] = useState(""),
    [fields, setFields] = useState({}),
    [confirmed, setConfirmed] = useState(false);
  const keys = [...new Set(n.fields || [])];
  const valid =
    title.trim() &&
    body.trim() &&
    confirmed &&
    keys.every((key) => fields[key]?.trim());
  return (
    <Modal title="提交最终产物" onClose={onClose}>
      <form
        className="run-mod-fields"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onSubmit({ title, body, fields, confirmed });
        }}
      >
        <Field label="产物名称">
          <input
            required
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="产物正文">
          <textarea
            required
            rows={5}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
        {keys.map((key) => (
          <Field key={key} label={key}>
            <input
              required
              value={fields[key] || ""}
              onChange={(e) =>
                setFields((prev) => ({ ...prev, [key]: e.target.value }))
              }
            />
          </Field>
        ))}
        <label className="run-final-check">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>我确认已满足团队完成条件：{r.finish || "交付件已就绪。"}</span>
        </label>
        <div className="dialog-actions">
          <Button onClick={onClose}>取消</Button>
          <Button type="submit" variant="primary" disabled={!valid}>
            提交并归档
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function RunDetail({ r, t }) {
  const { user, nav, ws, route, updateRun } = useStudio(),
    [form, setForm] = useState(null),
    [evidenceId, choose] = useState(null);
  const n = currentNode(r),
    done = r.status === "已完成",
    own = n?.owner === user,
    delivery = r.template === "delivery",
    options =
      !n || done ? [] : delivery ? optionsFor(r, n) : genericActions(r, n);
  const accessible = r.artifacts.filter((a) => isReadable(r, a, user));
  const a = accessible.find((i) => versionKey(i) === evidenceId),
    latest = n && lastOf(accessible, (x) => x.toId === n.id),
    planBody = r.design?.body;
  const env =
      n?.kind === "agent" &&
      ws.envs.find((e) => e.id === n.envId && e.owner === n.owner),
    verified =
      env?.status === "在线" &&
      env.providers.some((p) => p.name === n.provider && p.status === "已验证");
  const runReady = n?.kind !== "agent" || verified;
  function commit(option, body = "") {
    const expectedStep = r.current,
      revision = r.history.length;
    updateRun(
      (copy) => {
        const node = currentNode(copy);
        if (
          copy.current !== expectedStep ||
          copy.history.length !== revision ||
          copy.status === "已完成" ||
          node?.owner !== user ||
          !runReady
        )
          return;
        const available =
          copy.template === "delivery"
            ? optionsFor(copy, node)
            : genericActions(copy, node);
        if (!available.some((o) => o.id === option.id && !o.disabled)) return;
        if (copy.template === "delivery")
          applyDelivery(copy, node, option.id, body, user);
        else applyGeneric(copy, node, option.id, body, user);
      },
      t.id,
      r.id,
    );
    setForm(null);
  }
  return (
    <section className="run-view">
      <button
        type="button"
        className="run-back"
        onClick={() => nav("runs", { teamId: t.id, runId: null, nodeId: null })}
      >
        <ArrowLeft size={14} />
        运行记录
      </button>
      <header className="run-top">
        <div>
          <h1>{r.title}</h1>
          <div className="run-meta">
            <span className="run-code">{r.id}</span>
            <span>
              <Layers3 size={14} />
              {t.name}
            </span>
            <span>
              <GitBranch size={14} />
              流程 v{r.version}
            </span>
            <span>
              <Clock3 size={14} />
              {when(r.created)}
            </span>
          </div>
        </div>
        <div className="run-top-side">
          <Badge tone={toneFor(r.status)}>{r.status}</Badge>
        </div>
      </header>
      <div className="run-mode-tabs" aria-label="运行视图">
        {[
          ["action", "当前工作"],
          ["map", "运行画布"],
        ].map(([id, label]) => (
          <button
            type="button"
            key={id}
            aria-pressed={(route.tab === "map" ? "map" : "action") === id}
            onClick={() =>
              nav("run", {
                teamId: t.id,
                runId: r.id,
                nodeId: r.current,
                tab: id,
              })
            }
          >
            {id === "map" ? <GitBranch size={15} /> : <Route size={15} />}{" "}
            {label}
          </button>
        ))}
      </div>
      {route.tab === "map" ? (
        <RunMap r={r} t={t} />
      ) : (
        <>
          <ProgressRail r={r} t={t} />
          <div className="run-main-grid">
            <div className="run-column">
              <section className="run-card">
                <header className="run-card-head">
                  <div className="run-hgroup">
                    {done ? <CheckCheck size={18} /> : <Route size={18} />}
                    <h2>{done ? "交付结果" : "当前工作项"}</h2>
                  </div>
                  {!done && n && (
                    <Badge tone={n.kind === "human" ? "amber" : "blue"}>
                      {n.kind === "human" ? "真人" : "Agent"}
                    </Badge>
                  )}
                </header>
                {done ? (
                  <>
                    <div className="run-role-stripe">
                      <small>团队完成条件</small>
                      <strong>本次运行已完成</strong>
                    </div>
                    <p className="run-note">{r.finish}</p>
                  </>
                ) : n ? (
                  <>
                    <div className="run-role-stripe">
                      <small>
                        {n.owner} 负责 ·{" "}
                        {n.kind === "agent"
                          ? n.provider || "待绑定执行器"
                          : "人工处理"}
                      </small>
                      <strong>{n.name}</strong>
                    </div>
                    <p className="run-note">
                      {own ? describeStage(r, n) : n.duty}
                    </p>
                    {delivery &&
                    own &&
                    ["lead", "peer"].includes(n.action) &&
                    planBody ? (
                      <div className="run-fold">
                        <strong>待审技术方案 · v{r.design?.rev || 1}</strong>
                        <p className="run-inset">{planBody}</p>
                      </div>
                    ) : (
                      latest && (
                        <details className="run-fold">
                          <summary>
                            查看收到的《{latest.title}》v{latest.rev}
                          </summary>
                          <p>{latest.body}</p>
                        </details>
                      )
                    )}
                    {!own ? (
                      <div className="run-actions run-advisory">
                        <LockKeyhole size={15} />
                        当前工作由 {n.owner || "待分配成员"}{" "}
                        处理，你可查看已提交的交付件。
                      </div>
                    ) : !runReady ? (
                      <div className="run-actions run-advisory">
                        <LockKeyhole size={15} />
                        该角色绑定的执行环境或执行器尚未就绪。
                        <button
                          type="button"
                          className="run-icon-link"
                          onClick={() => nav("env")}
                        >
                          查看执行环境
                        </button>
                      </div>
                    ) : (
                      <div className="run-actions">
                        {options.map((option) => (
                          <Button
                            variant={option.primary ? "primary" : "default"}
                            key={option.id}
                            disabled={option.disabled}
                            onClick={() =>
                              option.form ? setForm(option) : commit(option)
                            }
                          >
                            {option.label}
                          </Button>
                        ))}
                        {!delivery && !options.length && (
                          <span className="run-note">
                            进入角色会话，准备并提交下一棒需要的产物。
                          </span>
                        )}
                      </div>
                    )}
                    <div className="run-fold">
                      <button
                        type="button"
                        className="run-icon-link"
                        onClick={() =>
                          nav("session", {
                            teamId: t.id,
                            runId: r.id,
                            nodeId: n.id,
                            tab: "from-run",
                          })
                        }
                      >
                        <MessageSquare size={15} />
                        进入角色会话
                        <ArrowUpRight size={14} />
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="run-note">此运行没有可显示的当前角色。</p>
                )}
              </section>
              <Timeline r={r} />
            </div>
            <aside className="run-column">
              <EvidenceCard
                items={accessible}
                choose={(a) => choose(versionKey(a))}
              />
              <section className="run-card">
                <header className="run-card-head">
                  <div className="run-hgroup">
                    <BookOpen size={17} />
                    <h2>完成条件</h2>
                  </div>
                </header>
                <p className="run-note">
                  {r.finish || "由当前流程的终点角色签收交付件。"}
                </p>
              </section>
            </aside>
          </div>
        </>
      )}
      {form &&
        (form.id === "final" ? (
          <FinalArtifactPrompt
            r={r}
            n={n}
            onClose={() => setForm(null)}
            onSubmit={(payload) => commit(form, payload)}
          />
        ) : (
          <ActionPrompt
            option={form}
            onClose={() => setForm(null)}
            onSubmit={(text) => commit(form, text)}
          />
        ))}{" "}
      {a && <EvidenceModal a={a} close={() => choose(null)} />}
    </section>
  );
}
function RunsList() {
  const { ws, team, user, nav, launch } = useStudio(),
    [filter, setFilter] = useState("全部"),
    [choose, setChoose] = useState(false);
  const candidates = team ? [team] : ws.teams,
    available = candidates.filter((t) => t.members?.includes(user)),
    runs = available
      .flatMap((t) => t.runs.map((r) => ({ t, r })))
      .sort((a, b) => new Date(b.r.created) - new Date(a.r.created));
  const filtered =
    filter === "全部" ? runs : runs.filter(({ r }) => r.status === filter);
  return (
    <section className="run-view">
      <header className="run-top">
        <div>
          <h1>运行记录</h1>
          <p className="run-sub">
            {team?.name || ws.name} · {runs.length} 次运行
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => (team ? launch(team.id) : setChoose(true))}
        >
          <Plus size={15} />
          发起运行
        </Button>
      </header>
      <div className="run-table-panel">
        <div className="run-filters" aria-label="筛选运行">
          {["全部", "进行中", "等待人工", "已完成"].map((f) => (
            <button
              type="button"
              aria-pressed={filter === f}
              className={"run-filter " + (filter === f ? "active" : "")}
              key={f}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <table className="run-table">
          <thead>
            <tr>
              <th>运行</th>
              <th>状态</th>
              <th className="run-hide-narrow">当前角色</th>
              <th className="run-hide-narrow">流程版本</th>
              <th aria-label="打开运行" />
            </tr>
          </thead>
          <tbody>
            {filtered.map(({ t, r }) => {
              const open = () =>
                nav("run", { teamId: t.id, runId: r.id, nodeId: r.current });
              return (
                <tr key={t.id + r.id} onClick={open}>
                  <td>
                    <button
                      type="button"
                      className="run-title-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        open();
                      }}
                    >
                      {r.title}
                    </button>
                    <span className="run-code">
                      {r.id}
                      {!team ? " · " + t.name : ""}
                    </span>
                  </td>
                  <td>
                    <Badge tone={toneFor(r.status)}>{r.status}</Badge>
                  </td>
                  <td className="run-hide-narrow">
                    {r.status === "已完成"
                      ? "—"
                      : currentNode(r)?.name || "待分配"}
                  </td>
                  <td className="run-hide-narrow">v{r.version}</td>
                  <td>
                    <ChevronRight size={15} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!filtered.length && (
          <div className="run-empty">
            {filter === "全部"
              ? "还没有运行记录。"
              : "没有符合筛选条件的运行。"}
          </div>
        )}
      </div>
      {choose && (
        <Modal title="选择运行团队" onClose={() => setChoose(false)}>
          <div className="run-mod-fields">
            {available
              .filter((t) => t.published)
              .map((t) => (
                <Button
                  key={t.id}
                  onClick={() => {
                    setChoose(false);
                    launch(t.id);
                  }}
                >
                  {t.name}
                  <ArrowRight size={14} />
                </Button>
              ))}
            {!available.some((t) => t.published) && (
              <p>请先在团队画布发布流程。</p>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}
export function Runs() {
  const { route, team, run, user, nav } = useStudio();
  if (route.page === "runs") return <RunsList key={team?.id || "all"} />;
  if (!team || !run || !team.members?.includes(user))
    return (
      <section className="run-view">
        <h1>无法打开此运行</h1>
        <p className="run-note">请从当前工作区选择有权访问的团队。</p>
        <Button
          onClick={() =>
            nav("runs", { teamId: null, runId: null, nodeId: null })
          }
        >
          返回运行记录
        </Button>
      </section>
    );
  return <RunDetail key={team.id + run.id} r={run} t={team} />;
}
