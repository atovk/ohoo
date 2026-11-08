import React, { createContext, useContext, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cva } from "class-variance-authority";
import { X } from "lucide-react";

export const uid = () =>
  globalThis.crypto.randomUUID?.() ||
  Date.now().toString(36) + Math.random().toString(36).slice(2);
export const clone = (x) => JSON.parse(JSON.stringify(x));
export const addEvent = (r, nodeId, text, actor = "林澄") => {
  r.history.push({
    id: uid(),
    nodeId,
    actor,
    text,
    time: new Date().toISOString(),
  });
};
export function advance(r, id, text, actor = "林澄") {
  const target = r.nodes.find((n) => n.id === id);
  if (!target) throw Error("找不到接收角色");
  r.current = id;
  r.status = target.kind === "human" ? "等待人工" : "进行中";
  addEvent(r, id, text, actor);
}
const buttonStyles = cva("button", {
  variants: {
    variant: {
      default: "button-default",
      primary: "button-primary",
      ghost: "button-ghost",
      danger: "button-danger",
    },
  },
  defaultVariants: { variant: "default" },
});
export function Button({
  children,
  variant = "default",
  className = "",
  type = "button",
  ...props
}) {
  return (
    <button
      type={type}
      className={buttonStyles({ variant }) + " " + className}
      {...props}
    >
      {children}
    </button>
  );
}
export function IconButton({ label, children, ...props }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="icon-button"
      {...props}
    >
      {children}
    </button>
  );
}
export function Field({ label, children, help }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {help && <small>{help}</small>}
    </label>
  );
}
export function Badge({ children, tone = "neutral" }) {
  return <span className={"badge badge-" + tone}>{children}</span>;
}
export function Modal({ title, children, onClose, description }) {
  return (
    <Dialog.Root
      open
      onOpenChange={(v) => {
        if (!v) onClose?.();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-shade" />
        <Dialog.Content className="dialog-box" aria-describedby={undefined}>
          <header>
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭弹窗"
              >
                <X size={17} />
              </button>
            </Dialog.Close>
          </header>
          {description && <p className="dialog-description">{description}</p>}
          <div className="dialog-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
const owner = "林澄";
const node = (id, name, kind, duty, output, x, y, extra = {}) => ({
  id,
  name,
  kind,
  owner,
  duty,
  output,
  x,
  y,
  action: id,
  skills: kind === "agent" ? ["项目协作"] : [],
  clis: kind === "agent" ? ["git"] : [],
  envId: kind === "agent" ? "mac" : "",
  provider: kind === "agent" ? "Claude Code" : "",
  model: kind === "agent" ? "默认模型" : "",
  cwd: "~/work/orders",
  fields: [],
  ...extra,
});
const edge = (from, to, label, mode = "auto") => ({
  id: from + "-" + to,
  from,
  to,
  label,
  mode,
});
export function makeTeam(name, template = "custom", member = owner) {
  const t = {
    id: uid(),
    name,
    template,
    goal: "",
    finish: "",
    members: [member],
    version: 0,
    dirty: true,
    nodes: [],
    edges: [],
    published: null,
    runs: [],
  };
  if (template === "delivery") {
    t.goal = "负责订单服务的需求交付";
    t.finish = "指定版本生产健康，业务样例由负责人签收。";
    t.nodes = [
      node(
        "intake",
        "需求整理",
        "agent",
        "确认业务范围、上游评审意见与验收样例。",
        "需求说明",
        20,
        40,
      ),
      node(
        "dev",
        "开发设计",
        "agent",
        "读取仓库和需求评审意见，列出可复用代码与计划改动。",
        "技术方案",
        280,
        40,
        { skills: ["代码阅读", "技术设计"], fields: ["验收样例"] },
      ),
      node(
        "lead",
        "开发负责人",
        "human",
        "编辑技术方案，决定直接开发或送专项设计评审。",
        "确认的设计",
        540,
        40,
      ),
      node(
        "peer",
        "专项评审",
        "human",
        "评审共享模块的影响与接口风险。",
        "评审结论",
        540,
        210,
      ),
      node(
        "impl",
        "开发实现",
        "agent",
        "依据已确认方案实现，提交代码变更和回归用例。",
        "修复 PR",
        280,
        210,
        { provider: "Codex" },
      ),
      node(
        "qa",
        "预发测试",
        "agent",
        "在预发验证候选制品，对照原样例签收或退回。",
        "测试报告",
        20,
        210,
      ),
      node(
        "sre",
        "发布验证",
        "agent",
        "按团队发布流程放量、回滚、验证技术指标。",
        "发布记录",
        20,
        380,
      ),
      node(
        "sign",
        "业务验收",
        "human",
        "核对生产实际用户路径并签收当前版本。",
        "业务签收",
        280,
        380,
      ),
    ];
    t.edges = [
      edge("intake", "dev", "范围已确认"),
      edge("dev", "lead", "提交设计", "manual"),
      edge("lead", "peer", "送专项评审"),
      edge("lead", "impl", "直接开发"),
      edge("peer", "impl", "评审通过"),
      edge("impl", "qa", "候选制品"),
      edge("qa", "impl", "缺陷退回"),
      edge("qa", "sre", "预发通过"),
      edge("sre", "sign", "全量健康"),
    ];
  } else if (template === "editorial") {
    t.goal = "把产品讨论整理成可交付的内容";
    t.finish = "责任编辑签收当前版本的定稿。";
    t.nodes = [
      node(
        "write",
        "撰稿",
        "agent",
        "从成员提供的材料起草文稿、标明出处。",
        "稿件",
        45,
        90,
        {
          cwd: "~/work/editorial",
          skills: ["需求整理", "内容编辑"],
          clis: [],
          fields: ["引用依据"],
        },
      ),
      node(
        "editor",
        "责任编辑",
        "human",
        "核对当前版，签收定稿或退回。",
        "签收记录",
        365,
        90,
      ),
    ];
    t.edges = [edge("write", "editor", "提交稿件", "manual")];
  }
  t.nodes.forEach((n) => (n.owner = member));
  return t;
}
function initialPublish(t, v) {
  t.version = v;
  t.dirty = false;
  t.published = clone({
    version: v,
    name: t.name,
    goal: t.goal,
    finish: t.finish,
    nodes: t.nodes,
    edges: t.edges,
    template: t.template,
  });
}
// The development walkthrough uses the shipped example. An edited topology runs
// through its tenant-defined links and explicit artifact handoffs.
function workflowSignature(flow) {
  return JSON.stringify({
    nodes: flow.nodes
      .map((n) => [n.id, n.action, n.kind, n.output, n.fields || []])
      .sort((a, b) => a[0].localeCompare(b[0])),
    edges: flow.edges
      .map((e) => [e.from, e.to, e.label, e.mode])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    finish: flow.finish,
  });
}
const deliverySignature = workflowSignature(makeTeam("", "delivery"));
export function isDeliveryExercise(t) {
  return (
    t.published?.template === "delivery" &&
    workflowSignature(t.published) === deliverySignature
  );
}
export function makeRun(t, title, type = "general", id, entryId) {
  const p = t.published;
  const example = isDeliveryExercise(t);
  const first =
    (example && type === "bug" && p.nodes.find((n) => n.id === "impl")) ||
    p.nodes.find((n) => n.id === entryId) ||
    p.nodes.find((n) => !p.edges.some((e) => e.to === n.id)) ||
    p.nodes[0];
  const r = {
    id: id || "RUN-" + uid().slice(0, 7).toUpperCase(),
    title,
    type,
    template: example
      ? "delivery"
      : p.template === "delivery"
        ? "custom"
        : p.template || t.template,
    version: p.version,
    nodes: clone(p.nodes),
    edges: clone(p.edges),
    finish: p.finish,
    status: first.kind === "human" ? "等待人工" : "进行中",
    current: first.id,
    history: [],
    artifacts: [],
    sessions: {},
    design: {
      rev: 1,
      body: "依据 D-01 及模拟仓库 src/orders/query.ts 的 listOrders、src/orders/export.ts 的 CSV 写入器：分页读取全部筛选结果，在导出层再判断一次订单权限。补跨页与越权用例。",
      route: "",
    },
    candidate: 1,
    rollout: { phase: "待放行" },
    created: new Date().toISOString(),
  };
  addEvent(r, first.id, "按已发布流程 v" + p.version + " 发起工作");
  return r;
}
function seed() {
  const orders = makeTeam("订单交付组", "delivery");
  orders.id = "orders";
  initialPublish(orders, 3);
  const editorial = makeTeam("内容编辑组", "editorial");
  editorial.id = "editorial";
  initialPublish(editorial, 2);
  const rd = makeRun(orders, "订单列表 CSV 导出", "feature", "OD-43");
  rd.created = "2026-11-08T09:10:00+08:00";
  rd.current = "lead";
  rd.status = "等待人工";
  rd.history = [];
  const event = (r, n, i, actor, text) =>
    r.history.push({
      id: uid(),
      nodeId: n,
      time: "2026-11-08T" + i + ":00+08:00",
      actor,
      text,
    });
  event(
    rd,
    "intake",
    "09:12",
    "需求整理",
    "确认 D-01：导出全部筛选结果，沿用订单权限。",
  );
  event(
    rd,
    "dev",
    "09:26",
    "开发设计",
    "查阅订单列表查询与 CSV 写入器，起草设计 v1。",
  );
  event(
    rd,
    "lead",
    "09:41",
    "开发设计",
    "提交技术方案 v1，等待开发负责人审阅。",
  );
  rd.artifacts.push({
    id: "d-01",
    rev: 1,
    nodeId: "intake",
    toId: "dev",
    title: "订单导出需求说明",
    body: "全部筛选结果共 43 条，保留列表排序和读取权限。",
    summary: "产品确认 D-01。",
    fields: {},
    status: "已签收",
    actor: "林澄",
  });
  rd.artifacts.push({
    id: "plan-seed",
    rev: 1,
    nodeId: "dev",
    toId: "lead",
    title: "订单导出技术方案",
    body: rd.design.body,
    summary: "请审阅分页取数与权限判断是否应复用现有查询。",
    fields: { 验收样例: "授权账号导出 43 条。" },
    status: "待签收",
    actor: "林澄",
  });
  orders.runs.push(rd);
  const ed = makeRun(editorial, "十一月产品更新说明", "general", "ED-07");
  ed.created = "2026-11-08T10:00:00+08:00";
  ed.history = [];
  ed.current = "editor";
  ed.status = "等待人工";
  event(ed, "editor", "10:08", "撰稿", "提交更新说明 v1，等待编辑签收。");
  ed.artifacts.push({
    id: "draft-7",
    rev: 1,
    nodeId: "write",
    toId: "editor",
    title: "产品更新说明",
    body: "本次更新支持从团队画布直接进入角色会话。",
    summary: "请确认描述及引用依据。",
    fields: { 引用依据: "成员提供的产品评审摘录" },
    status: "待签收",
    actor: "林澄",
  });
  ed.sessions.write = {
    mode: "ready",
    draft: "",
    pending: null,
    staged: null,
    messages: [
      {
        id: "editorial-brief",
        from: "user",
        text: "补充今天评审会的决定：成员可以直接从角色节点进入会话。请把这项变化写进十一月的产品更新说明。",
      },
      {
        id: "editorial-copy",
        from: "agent",
        text: "产品更新说明 · 草稿 v1\n\n成员现在可以在团队画布点击角色，直接进入本次工作的 agent 会话，随时补充会议摘录或自己的说明。\n\n引用依据为你刚提供的评审会决定。已提交的稿件等待责任编辑签收。",
      },
    ],
  };
  editorial.runs.push(ed);
  const old = makeRun(editorial, "十月编辑规范归档", "general", "ED-05");
  old.created = "2026-10-30T08:00:00+08:00";
  old.history = [];
  old.status = "已完成";
  old.current = "editor";
  event(old, "editor", "08:30", "林澄", "签收编辑规范 v2 并完成归档。");
  old.history[0].time = "2026-10-30T08:30:00+08:00";
  old.artifacts.push({
    id: "guide-5",
    rev: 2,
    nodeId: "write",
    toId: "editor",
    title: "编辑规范",
    body: "每个交付件关联固定版本。",
    summary: "本版已归档。",
    fields: { 引用依据: "十月编辑例会" },
    status: "已签收",
    actor: "林澄",
  });
  editorial.runs.push(old);
  const privateTeam = makeTeam("内部知识编辑组", "editorial");
  privateTeam.id = "internal";
  initialPublish(privateTeam, 1);
  return {
    schema: 2,
    activeSpace: "cloud",
    spaces: [
      {
        id: "cloud",
        name: "野渡科技",
        mode: "cloud",
        members: ["林澄", "宋遥", "齐越"],
        allowRemote: true,
        serviceAddress: "",
        teams: [orders, editorial],
        envs: [
          {
            id: "mac",
            name: "林澄的 Mac",
            owner,
            kind: "local",
            status: "在线",
            providers: [
              { name: "Claude Code", status: "已验证", models: ["默认模型"] },
              { name: "Codex", status: "已验证", models: ["默认模型"] },
              { name: "pi", status: "需登录", models: [] },
            ],
          },
        ],
      },
      {
        id: "private",
        name: "北屿实验室",
        mode: "self",
        members: ["林澄", "顾舟"],
        allowRemote: false,
        serviceAddress: "https://ohoo.example.internal",
        teams: [privateTeam],
        envs: [],
      },
    ],
  };
}
const key = "ohoo.studio-v2.preview.1";
const initialRoute = {
  page: "home",
  teamId: null,
  runId: null,
  nodeId: null,
  tab: "",
};
const pages = new Set([
  "home",
  "teams",
  "canvas",
  "run",
  "runs",
  "session",
  "inbox",
  "artifacts",
  "env",
  "settings",
  "onboard",
]);
function loadRoute(space) {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get("workspace") !== space || !pages.has(params.get("page")))
    return initialRoute;
  return {
    page: params.get("page"),
    teamId: params.get("team"),
    runId: params.get("run"),
    nodeId: params.get("node"),
    tab: params.get("tab") || "",
  };
}
function setLocation(next, space, replace = false) {
  const params = new URLSearchParams({ workspace: space, page: next.page });
  for (const [field, name] of [
    ["teamId", "team"],
    ["runId", "run"],
    ["nodeId", "node"],
    ["tab", "tab"],
  ])
    if (next[field]) params.set(name, next[field]);
  const hash = "#" + params.toString();
  if (location.hash !== hash)
    history[replace ? "replaceState" : "pushState"](null, "", hash);
}
const Context = createContext(null);
export const useStudio = () => useContext(Context);
export function StudioProvider({ children }) {
  const [db, setDb] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      if (v?.schema === 2 && v.spaces?.some((s) => s.id === v.activeSpace))
        return v;
    } catch {}
    return seed();
  });
  const [route, setRoute] = useState(() => loadRoute(db.activeSpace)),
    [notification, setNotification] = useState(null),
    [launchId, setLaunchId] = useState(null);
  const ws = db.spaces.find((s) => s.id === db.activeSpace),
    team = ws.teams.find((t) => t.id === route.teamId),
    run = team?.runs.find((r) => r.id === route.runId);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(db));
    } catch {}
  }, [db]);
  useEffect(() => {
    if (!notification) return;
    const t = setTimeout(() => setNotification(null), 3000);
    return () => clearTimeout(t);
  }, [notification]);
  const toast = (text) => setNotification({ id: uid(), text: String(text) });
  useEffect(() => {
    const restore = () => {
      setRoute(loadRoute(db.activeSpace));
      setLaunchId(null);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [db.activeSpace]);
  const nav = (page, opts = {}) => {
    const next = { ...route, page, tab: "", ...opts };
    setRoute(next);
    setLocation(next, ws.id);
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  const patch = (fn, which = db.activeSpace) =>
    setDb((prev) => {
      const d = clone(prev),
        target = d.spaces.find((w) => w.id === which);
      if (!target) return prev;
      fn(target);
      return d;
    });
  const updateWs = (fn) => patch(fn);
  const updateTeam = (fn, id = route.teamId) =>
    patch((w) => {
      const t = w.teams.find((x) => x.id === id);
      if (t) fn(t);
    });
  const updateRun = (fn, tid = route.teamId, rid = route.runId) =>
    patch((w) => {
      const r = w.teams
        .find((t) => t.id === tid)
        ?.runs.find((r) => r.id === rid);
      if (r) fn(r);
    });
  const switchWs = (id) => {
    if (!db.spaces.some((w) => w.id === id)) return;
    setDb((d) => ({ ...d, activeSpace: id }));
    setLaunchId(null);
    setNotification(null);
    setRoute(initialRoute);
    setLocation(initialRoute, id);
  };
  const createSpace = ({ name, mode }) => {
    const w = {
      id: uid(),
      name: name.trim(),
      mode,
      members: [owner],
      allowRemote: mode === "cloud",
      serviceAddress: "",
      envs: [],
      teams: [],
    };
    setDb((d) => ({ ...d, spaces: [...d.spaces, w], activeSpace: w.id }));
    setNotification(null);
    setLaunchId(null);
    setRoute(initialRoute);
    setLocation(initialRoute, w.id);
    return w.id;
  };
  const launch = (id) => {
    const t = ws.teams.find((t) => t.id === id);
    if (!t?.published?.nodes.length) {
      toast("请先发布包含角色的流程");
      if (t) nav("canvas", { teamId: t.id });
      else nav("teams");
      return;
    }
    setLaunchId(id);
  };
  const reset = () => {
    setDb(seed());
    setLaunchId(null);
    setRoute(initialRoute);
    setLocation(initialRoute, "cloud", true);
    toast("已恢复演示数据");
  };
  const data = {
    db,
    ws,
    team,
    run,
    route,
    user: owner,
    nav,
    updateWs,
    updateTeam,
    updateRun,
    switchWs,
    createSpace,
    toast,
    launch,
    reset,
  };
  return (
    <Context.Provider value={data}>
      {children}
      {launchId && <Launch teamId={launchId} close={() => setLaunchId(null)} />}
      {notification && (
        <div className="toast" role="status">
          {notification.text}
        </div>
      )}
    </Context.Provider>
  );
}
function Launch({ teamId, close }) {
  const { ws, updateTeam, nav, toast } = useStudio(),
    t = ws.teams.find((x) => x.id === teamId),
    [title, setTitle] = useState(""),
    [type, setType] = useState(isDeliveryExercise(t) ? "feature" : "general");
  const [entry, setEntry] = useState(
    () =>
      t.published.nodes.find(
        (n) => !t.published.edges.some((e) => e.to === n.id),
      )?.id || t.published.nodes[0].id,
  );
  const [repro, setRepro] = useState(
    "订单筛选命中 43 条，导出仅返回第一页 20 条；预期导出全部有权读取的订单。",
  );
  return (
    <Modal title="发起工作" onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          const r = makeRun(t, title.trim(), type, undefined, entry);
          if (type === "bug") {
            if (!repro.trim()) return;
            r.feedback = repro.trim();
            r.artifacts.push({
              id: uid(),
              rev: 1,
              nodeId: r.current,
              toId: r.current,
              title: "缺陷复现记录",
              body: r.feedback,
              summary: "直接修复的输入依据",
              fields: {},
              status: "已签收",
              actor: owner,
            });
          }
          updateTeam((t) => t.runs.unshift(r), t.id);
          close();
          nav("run", { teamId: t.id, runId: r.id, nodeId: r.current });
          toast("已按流程 v" + r.version + " 发起工作");
        }}
      >
        <p className="muted">
          {t.name} · 已发布 v{t.version}
        </p>
        <Field label="本次委托">
          <input
            autoFocus
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="写下这次要交付的结果"
          />
        </Field>
        {isDeliveryExercise(t) && (
          <Field label="工作类型">
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="feature">功能需求 · 从需求确认开始</option>
              <option value="bug">已复现的 bug · 直接进入修复</option>
            </select>
          </Field>
        )}
        {!isDeliveryExercise(t) && (
          <Field label="起始角色">
            <select value={entry} onChange={(e) => setEntry(e.target.value)}>
              {t.published.nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {type === "bug" && (
          <Field label="复现步骤、预期与实际结果">
            <textarea
              rows={3}
              required
              value={repro}
              onChange={(e) => setRepro(e.target.value)}
            />
          </Field>
        )}
        <p className="form-help">完成条件 · {t.published.finish}</p>
        <div className="dialog-actions">
          <Button onClick={close}>取消</Button>
          <Button type="submit" variant="primary">
            发起工作
          </Button>
        </div>
      </form>
    </Modal>
  );
}
