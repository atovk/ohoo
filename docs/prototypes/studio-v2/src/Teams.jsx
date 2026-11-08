import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  ConnectionMode,
  applyNodeChanges,
  BaseEdge,
  getSmoothStepPath,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowUpRight,
  Bot,
  Boxes,
  ChevronRight,
  CircleAlert,
  FileText,
  GitBranch,
  GitPullRequest,
  Grip,
  List,
  Monitor,
  Network,
  Pencil,
  Play,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Terminal,
  Trash2,
  UserRound,
  Users,
  Workflow,
} from "lucide-react";
import {
  useStudio,
  uid,
  clone,
  makeTeam,
  Button,
  Modal,
  Field,
  Badge,
} from "./studio";
import "./teams.css";

const TEAM_TEMPLATES = [
  {
    id: "custom",
    label: "空白团队",
    text: "自己配置角色和交接规则。",
    icon: Plus,
  },
  {
    id: "delivery",
    label: "订单研发",
    text: "从需求设计到生产验收。",
    icon: GitPullRequest,
  },
  {
    id: "editorial",
    label: "内容编辑",
    text: "撰稿、审阅、交付定稿。",
    icon: FileText,
  },
];
const tiles = { w: 205, h: 92 };
const words = (value) => [
  ...new Set(
    String(value || "")
      .split(/[,，、；;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];
const versionOf = (t) => (t.published ? `v${t.published.version}` : "未发布");
const statusOf = (t) =>
  t.published ? (t.dirty ? "有未发布修改" : "已发布") : "草稿";
const namesOf = (ws) =>
  (ws.members || []).map((item) =>
    typeof item === "string" ? item : item.name,
  );
const providerName = (p) => (typeof p === "string" ? p : p.name);
const uniquePositions = (nodes) => {
  for (let row = 0; ; row++) {
    for (let col = 0; col < 3; col++) {
      const x = 40 + col * 270,
        y = 40 + row * 150;
      if (
        !nodes.some(
          (n) =>
            Math.abs((n.x || 0) - x) < tiles.w + 16 &&
            Math.abs((n.y || 0) - y) < tiles.h + 16,
        )
      )
        return { x, y };
    }
  }
};
function validateTeam(team, workspace) {
  const errors = [],
    warnings = [];
  if (!team.name?.trim() || !team.goal?.trim() || !team.finish?.trim())
    errors.push("填写团队名称、长期目标和任务完成条件。");
  if (!team.nodes.length) errors.push("至少添加一个负责角色。");
  const ids = new Set(team.nodes.map((n) => n.id)),
    members = team.members?.length ? team.members : namesOf(workspace);
  for (const n of team.nodes) {
    const label = n.name || "未命名角色";
    if (!n.name?.trim() || !n.duty?.trim() || !n.output?.trim())
      errors.push(`${label}需要名称、职责和交付产物。`);
    if (!members.includes(n.owner))
      errors.push(`${label}需要指定该团队的成员。`);
    if (n.kind !== "agent") continue;
    const env = workspace.envs.find(
        (e) => e.id === n.envId && e.owner === n.owner,
      ),
      p = env?.providers?.find((p) => providerName(p) === n.provider);
    if (!env || !p)
      errors.push(`${label}尚未绑定执行环境或该环境已发现的执行器。`);
    else if (env.status === "离线" || p.status !== "已验证")
      warnings.push(
        `${label}绑定的 ${env.name} / ${n.provider} 需在运行时在线且通过验证。`,
      );
  }
  for (const e of team.edges)
    if (
      !ids.has(e.from) ||
      !ids.has(e.to) ||
      e.from === e.to ||
      !e.label?.trim()
    )
      errors.push("有交接缺少有效端点或条件。");
  const isolated = team.nodes.filter(
    (n) => !team.edges.some((e) => e.from === n.id || e.to === n.id),
  );
  if (team.nodes.length > 1 && isolated.length)
    warnings.push(`未连接的角色：${isolated.map((n) => n.name).join("、")}。`);
  return { errors, warnings };
}
function flowPorts(from, to) {
  const dx = to.x - from.x,
    dy = to.y - from.y;
  if (Math.abs(dx) > Math.abs(dy))
    return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}
const RoleTile = React.memo(function RoleTile({ data, selected }) {
  const n = data.role,
    human = n.kind === "human",
    Icon = human ? UserRound : Terminal;
  return (
    <div
      className={`td-flow-node ${human ? "is-human" : ""} ${selected ? "is-selected" : ""}`}
    >
      {Object.entries({
        top: Position.Top,
        right: Position.Right,
        bottom: Position.Bottom,
        left: Position.Left,
      }).map(([id, position]) => (
        <Handle
          key={id}
          id={id}
          type="source"
          position={position}
          className="td-handle"
        />
      ))}
      <div className="td-node-top">
        <span className="td-node-icon">
          <Icon size={15} />
        </span>
        <span className="td-node-kind">{human ? "真人" : "Agent"}</span>
      </div>
      <div className="td-node-title">{n.name}</div>
      <div className="td-node-meta">
        {human
          ? n.owner || "待指派"
          : `${n.provider || "待绑定执行器"}${n.owner ? " · " + n.owner : ""}`}
      </div>
    </div>
  );
});
const nodeTypes = { role: RoleTile };
function TeamPreview({ team }) {
  if (!team.nodes.length)
    return (
      <div className="td-mini-empty">
        <Workflow size={30} />
      </div>
    );
  const nodes = team.nodes.slice(0, 8),
    xs = nodes.map((n) => n.x || 0),
    ys = nodes.map((n) => n.y || 0),
    minX = Math.min(...xs),
    minY = Math.min(...ys),
    spanX = Math.max(205, Math.max(...xs) - minX + 205),
    spanY = Math.max(92, Math.max(...ys) - minY + 92);
  const scale = Math.min(250 / spanX, 87 / spanY),
    left = (274 - spanX * scale) / 2,
    top = (116 - spanY * scale) / 2;
  const rect = (n) => ({
    x: left + ((n.x || 0) - minX) * scale,
    y: top + ((n.y || 0) - minY) * scale,
    w: 205 * scale,
    h: 92 * scale,
  });
  const selected = nodes.find((n) => n.kind === "human") || nodes[0];
  return (
    <svg
      viewBox="0 0 274 116"
      className="td-mini-flow"
      aria-label={`${team.name}的角色关系图`}
    >
      {team.edges.map((e) => {
        const a = nodes.find((n) => n.id === e.from),
          b = nodes.find((n) => n.id === e.to);
        if (!a || !b) return null;
        const r = rect(a),
          q = rect(b),
          x = r.x + r.w / 2,
          y = r.y + r.h / 2,
          X = q.x + q.w / 2,
          Y = q.y + q.h / 2;
        return (
          <path
            key={e.id}
            d={`M${x} ${y} H${(x + X) / 2} V${Y} H${X}`}
            fill="none"
            stroke="#7687a4"
            strokeWidth="1.2"
            strokeDasharray={e.mode === "manual" ? "3 3" : undefined}
          />
        );
      })}
      {nodes.map((n) => {
        const r = rect(n),
          focus = n.id === selected.id;
        return (
          <g key={n.id}>
            <rect
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              rx={n.kind === "human" ? 4 : 2}
              fill={focus ? "#dfee9d" : "#fff"}
              stroke={focus ? "#374c36" : "#7d8b9c"}
              strokeDasharray={n.kind === "human" ? "3 2" : undefined}
            />
            <circle
              cx={r.x + r.w * 0.16}
              cy={r.y + r.h * 0.5}
              r={Math.min(2.6, r.h * 0.1)}
              fill={focus ? "#365140" : "#5369a0"}
            />
            <path
              d={`M${r.x + r.w * 0.3} ${r.y + r.h * 0.43} h${r.w * 0.47} M${r.x + r.w * 0.3} ${r.y + r.h * 0.63} h${r.w * 0.29}`}
              fill="none"
              stroke={focus ? "#688451" : "#b1bac6"}
              strokeWidth="1.5"
            />
          </g>
        );
      })}
    </svg>
  );
}
function RoleForm({ role, team, ws, onSave, onCancel }) {
  const [error, setError] = useState("");
  const [item, set] = useState(() => ({
    ...role,
    skills: (role.skills || []).join("，"),
    clis: (role.clis || []).join("，"),
    fields: (role.fields || []).join("，"),
  }));
  const field = (name, val) => set((o) => ({ ...o, [name]: val }));
  const members = team.members?.length ? team.members : namesOf(ws),
    envs = (ws.envs || []).filter((e) => e.owner === item.owner),
    env = envs.find((e) => e.id === item.envId),
    pr = env?.providers?.find((p) => providerName(p) === item.provider);
  const human = item.kind === "human";
  return (
    <form
      className="td-form"
      onSubmit={(e) => {
        e.preventDefault();
        const n = {
          ...item,
          name: item.name.trim(),
          duty: item.duty.trim(),
          output: item.output.trim(),
          skills: human ? [] : words(item.skills),
          clis: human ? [] : words(item.clis),
          fields: words(item.fields),
          envId: human ? "" : item.envId,
          provider: human ? "" : item.provider,
          model: human ? "" : item.model || "",
          cwd: human ? "" : (item.cwd || "").trim(),
        };
        if (!n.name || !n.duty || !n.output) {
          setError("填写名称、职责和交付产物。");
          return;
        }
        onSave(n);
      }}
    >
      <div className="td-form-row">
        <Field label="角色名称">
          <input
            required
            autoFocus
            value={item.name}
            onChange={(e) => field("name", e.target.value)}
            maxLength={48}
            placeholder="例如：内容编辑"
          />
        </Field>
        <Field label="角色类型">
          <select
            aria-label="角色类型"
            value={item.kind}
            onChange={(e) => field("kind", e.target.value)}
          >
            <option value="agent">Agent</option>
            <option value="human">真人</option>
          </select>
        </Field>
      </div>
      <Field label="负责成员">
        <select
          aria-label="负责成员"
          required
          value={item.owner}
          onChange={(e) =>
            set((o) => ({
              ...o,
              owner: e.target.value,
              envId: "",
              provider: "",
              model: "",
            }))
          }
        >
          <option value="">选择成员</option>
          {members.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </Field>
      <Field label="职责">
        <textarea
          required
          rows={2}
          value={item.duty}
          onChange={(e) => field("duty", e.target.value)}
          placeholder="负责哪些工作，交给谁验收？"
        />
      </Field>
      <div className="td-form-row">
        <Field label="交付产物">
          <input
            required
            value={item.output}
            onChange={(e) => field("output", e.target.value)}
            placeholder="例如：验收报告"
          />
        </Field>
        <Field label="产物必填字段">
          <input
            value={item.fields}
            onChange={(e) => field("fields", e.target.value)}
            placeholder="多项用逗号分隔"
          />
        </Field>
      </div>
      {!human && (
        <div className="td-form-section">
          <h3>
            <Monitor size={15} /> 执行绑定
          </h3>
          <div className="td-form-row">
            <Field label="成员的执行环境">
              <select
                aria-label="成员的执行环境"
                value={env ? item.envId : ""}
                onChange={(e) =>
                  set((o) => ({
                    ...o,
                    envId: e.target.value,
                    provider: "",
                    model: "",
                  }))
                }
              >
                <option value="">选择环境</option>
                {envs.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} · {e.status}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Coding agent">
              <select
                aria-label="Coding agent"
                value={pr ? item.provider : ""}
                onChange={(e) =>
                  set((o) => ({ ...o, provider: e.target.value, model: "" }))
                }
              >
                <option value="">选择已发现的执行器</option>
                {(env?.providers || []).map((p) => (
                  <option key={providerName(p)} value={providerName(p)}>
                    {providerName(p)}
                    {p.status ? " · " + p.status : ""}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {(!env || !pr || env.status === "离线" || pr.status !== "已验证") && (
            <p className="td-binding-hint">
              <CircleAlert size={14} />
              {!env
                ? "可先保存草稿，再补充成员的执行环境。"
                : !pr
                  ? "请选择此环境已发现的执行器。"
                  : `${env.name} ${env.status}，${item.provider} ${pr.status}。运行前需验证连接。`}
            </p>
          )}
          {pr?.models?.length > 0 && (
            <Field label="模型">
              <select
                aria-label="模型"
                value={item.model || ""}
                onChange={(e) => field("model", e.target.value)}
              >
                <option value="">使用执行器默认模型</option>
                {pr.models.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </Field>
          )}
          <Field label="工作目录">
            <input
              value={item.cwd || ""}
              onChange={(e) => field("cwd", e.target.value)}
              placeholder="执行主机中的仓库或目录"
            />
          </Field>
          <div className="td-form-row">
            <Field label="Skills">
              <input
                value={item.skills}
                onChange={(e) => field("skills", e.target.value)}
                placeholder="多项用逗号分隔"
              />
            </Field>
            <Field label="业务 CLI">
              <input
                value={item.clis}
                onChange={(e) => field("clis", e.target.value)}
                placeholder="例如：git，lark-cli"
              />
            </Field>
          </div>
        </div>
      )}
      <details className="td-coordinates">
        <summary>画布位置</summary>
        <div className="td-form-row">
          {["x", "y"].map((axis) => (
            <Field key={axis} label={axis.toUpperCase() + " 坐标"}>
              <input
                type="number"
                value={item[axis] ?? 0}
                onChange={(e) => field(axis, Number(e.target.value))}
              />
            </Field>
          ))}
        </div>
      </details>
      {error && (
        <p role="alert" className="td-form-error">
          {error}
        </p>
      )}
      <div className="td-form-foot">
        <Button type="button" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" variant="primary">
          保存角色
        </Button>
      </div>
    </form>
  );
}
function EdgeForm({ edge, team, onSave, onCancel }) {
  const [value, set] = useState(edge),
    [error, setError] = useState("");
  const change = (key, val) => set((v) => ({ ...v, [key]: val }));
  return (
    <form
      className="td-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.from === value.to) return setError("请选择两个不同的角色。");
        if (!value.label.trim()) return setError("请填写交接条件或产物。");
        if (
          team.edges.some(
            (ed) =>
              ed.id !== value.id &&
              ed.from === value.from &&
              ed.to === value.to &&
              ed.label === value.label.trim(),
          )
        )
          return setError("相同交接已存在。");
        onSave({ ...value, label: value.label.trim() });
      }}
    >
      <div className="td-form-row">
        {[
          ["from", "发起角色"],
          ["to", "接收角色"],
        ].map(([k, l]) => (
          <Field label={l} key={k}>
            <select
              aria-label={l}
              required
              value={value[k]}
              onChange={(e) => change(k, e.target.value)}
            >
              {team.nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </Field>
        ))}
      </div>
      <Field label="交接条件或产物">
        <input
          autoFocus
          required
          value={value.label}
          onChange={(e) => change("label", e.target.value)}
          placeholder="例如：设计方案已确认"
        />
      </Field>
      <Field label="交接方式">
        <select
          aria-label="交接方式"
          value={value.mode}
          onChange={(e) => change("mode", e.target.value)}
        >
          <option value="auto">自动交接</option>
          <option value="manual">人工转交</option>
        </select>
      </Field>
      {error && (
        <p role="alert" className="td-form-error">
          {error}
        </p>
      )}
      <div className="td-form-foot">
        <Button type="button" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" variant="primary">
          保存交接
        </Button>
      </div>
    </form>
  );
}
function TeamForm({ ws, user, team, onSave, onCancel }) {
  const [values, set] = useState(() => ({
    name: team?.name || "",
    template: team?.template || "custom",
    goal: team?.goal || "",
    finish: team?.finish || "",
    owner: team?.owner || user,
    members: team?.members || [user],
  }));
  const [error, setError] = useState("");
  const change = (key, v) => set((prev) => ({ ...prev, [key]: v }));
  function chooseTemplate(template) {
    const sample = makeTeam(values.name, template, user),
      before = makeTeam(values.name, values.template, user);
    set((prev) => ({
      ...prev,
      template,
      goal: !prev.goal || prev.goal === before.goal ? sample.goal : prev.goal,
      finish:
        !prev.finish || prev.finish === before.finish
          ? sample.finish
          : prev.finish,
    }));
  }
  return (
    <form
      className="td-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!values.name.trim() || !values.goal.trim() || !values.finish.trim())
          return setError("填写团队名称、长期目标和完成条件。");
        onSave({
          ...values,
          name: values.name.trim(),
          goal: values.goal.trim(),
          finish: values.finish.trim(),
          members: [...new Set([values.owner, ...values.members])],
        });
      }}
    >
      {!team && (
        <fieldset className="td-group">
          <legend>创建方式</legend>
          <div className="td-choice-grid">
            {TEAM_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`td-choice ${t.id === values.template ? "is-selected" : ""}`}
                onClick={() => chooseTemplate(t.id)}
                aria-pressed={t.id === values.template}
              >
                <t.icon size={19} />
                <strong>{t.label}</strong>
                <small>{t.text}</small>
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <div className="td-form-row">
        <Field label="团队名称">
          <input
            autoFocus
            required
            maxLength={48}
            value={values.name}
            onChange={(e) => change("name", e.target.value)}
            placeholder="例如：内容编辑组"
          />
        </Field>
        <Field label="团队负责人">
          <select
            aria-label="团队负责人"
            value={values.owner}
            onChange={(e) => change("owner", e.target.value)}
          >
            {namesOf(ws).map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="长期目标">
        <input
          required
          value={values.goal}
          onChange={(e) => change("goal", e.target.value)}
          placeholder="这个团队持续负责什么？"
        />
      </Field>
      <Field label="每次运行的完成条件">
        <textarea
          required
          rows={2}
          value={values.finish}
          onChange={(e) => change("finish", e.target.value)}
          placeholder="例如：责任编辑签收当前版本并归档"
        />
      </Field>
      <fieldset className="td-group">
        <legend>团队成员</legend>
        <div className="td-members">
          {namesOf(ws).map((n) => (
            <label key={n}>
              <input
                type="checkbox"
                checked={values.members.includes(n) || n === values.owner}
                disabled={n === values.owner}
                onChange={(e) =>
                  change(
                    "members",
                    e.target.checked
                      ? [...values.members, n]
                      : values.members.filter((x) => x !== n),
                  )
                }
              />
              {n}
            </label>
          ))}
        </div>
      </fieldset>
      {error && (
        <p className="td-form-error" role="alert">
          {error}
        </p>
      )}
      <div className="td-form-foot">
        <Button type="button" onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" variant="primary">
          {team ? "保存团队信息" : "创建并进入画布"}
        </Button>
      </div>
    </form>
  );
}
function TeamsDirectory() {
  const { ws, user, route, nav, updateWs, toast } = useStudio();
  const [create, setCreate] = useState(false),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("全部");
  useEffect(() => {
    if (route.tab === "new") {
      setCreate(true);
      nav("teams", { tab: "" });
    }
  }, [route.tab]);
  const matches = ws.teams.filter(
    (t) =>
      (filter === "全部" ||
        (filter === "已发布" ? !!t.published : !t.published || t.dirty)) &&
      [t.name, t.goal, ...(t.members || [])]
        .join(" ")
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  function createTeam(v) {
    const t = makeTeam(v.name, v.template, v.owner);
    Object.assign(t, {
      owner: v.owner,
      goal: v.goal,
      finish: v.finish,
      members: v.members,
      dirty: true,
    });
    t.nodes = t.nodes.map((n) => {
      const validOwner = v.members.includes(n.owner),
        owner = validOwner ? n.owner : v.owner,
        env = ws.envs.find((e) => e.id === n.envId && e.owner === owner);
      return {
        ...n,
        owner,
        envId: env?.id || "",
        provider: env?.providers?.some((p) => providerName(p) === n.provider)
          ? n.provider
          : "",
        model: env?.providers?.some(
          (p) => providerName(p) === n.provider && p.models?.includes(n.model),
        )
          ? n.model
          : "",
      };
    });
    updateWs((w) => {
      w.teams.unshift(t);
    });
    setCreate(false);
    nav("canvas", { teamId: t.id, runId: null, nodeId: null });
    toast("团队已创建，可以配置角色。");
  }
  return (
    <section className="td-page">
      <header className="td-head">
        <div className="td-heading">
          <h1>团队目录</h1>
          <p>
            {ws.name} · {ws.teams.length} 个团队
          </p>
        </div>
        <div className="td-head-actions">
          <Button variant="primary" onClick={() => setCreate(true)}>
            <Plus size={16} />
            新建团队
          </Button>
        </div>
      </header>
      <div className="td-tools">
        <div className="td-filter" aria-label="筛选团队">
          {["全部", "已发布", "草稿"].map((key) => (
            <button
              key={key}
              type="button"
              className={`td-seg ${filter === key ? "is-selected" : ""}`}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {key}
            </button>
          ))}
        </div>
        <label className="td-search">
          <Search size={15} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="搜索团队"
            placeholder="搜索团队、成员…"
          />
        </label>
      </div>
      <div className="td-grid">
        {matches.map((t) => (
          <button
            key={t.id}
            type="button"
            className="td-card"
            onClick={() =>
              nav("canvas", { teamId: t.id, runId: null, nodeId: null })
            }
          >
            <div className="td-card-cover">
              <div className="td-card-topline">
                <Badge tone={t.published && !t.dirty ? "green" : "amber"}>
                  {statusOf(t)}
                </Badge>
                <span>{versionOf(t)}</span>
              </div>
              <TeamPreview team={t} />
            </div>
            <div className="td-card-content">
              <h2>
                {t.name}
                <ArrowUpRight size={18} />
              </h2>
              <p>{t.goal}</p>
            </div>
            <div className="td-card-meta">
              <span>
                <Workflow size={14} />
                {t.nodes.length} 个角色
              </span>
              <span>
                <Users size={14} />
                {t.members.length} 位成员
              </span>
              <span>{t.runs.length} 次运行</span>
            </div>
          </button>
        ))}
      </div>
      {!matches.length && (
        <div className="td-empty">
          <Boxes size={30} />
          <h3>{ws.teams.length ? "没有匹配的团队" : "创建第一个团队"}</h3>
          <p>
            {ws.teams.length
              ? "更换搜索词或筛选条件。"
              : "从空白或团队模板开始。"}
          </p>
          {!ws.teams.length && (
            <Button onClick={() => setCreate(true)}>
              <Plus size={15} />
              新建团队
            </Button>
          )}
        </div>
      )}
      {create && (
        <Modal title="创建团队" onClose={() => setCreate(false)}>
          <TeamForm
            ws={ws}
            user={user}
            onSave={createTeam}
            onCancel={() => setCreate(false)}
          />
        </Modal>
      )}
    </section>
  );
}
function applyLayout(teamNodes, selected) {
  return teamNodes.map((n) => ({
    id: n.id,
    type: "role",
    position: { x: n.x || 0, y: n.y || 0 },
    selected: n.id === selected,
    data: { role: n },
    ariaLabel: `${n.name}，${n.kind === "human" ? "真人" : "Agent"}，${n.owner || "待指派"}`,
  }));
}
function HandoffEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  label,
  data,
}) {
  const [path, x, y] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 6,
    offset: data?.returnPath ? 30 : 18,
  });
  const horizontal =
    sourcePosition === Position.Left || sourcePosition === Position.Right;
  const vertical = !horizontal && !data?.returnPath;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={style}
        markerEnd={markerEnd}
        interactionWidth={20}
      />
      {label && (
        <text
          className="td-edge-caption"
          x={x + (vertical ? 8 : 0)}
          y={y + (vertical ? 3 : -7)}
          textAnchor={vertical ? "start" : "middle"}
          fill="#46565c"
          stroke="#f7f8f7"
          strokeWidth={4}
          paintOrder="stroke"
          fontSize="11"
          fontWeight="560"
          pointerEvents="none"
        >
          {label}
        </text>
      )}
    </>
  );
}
const edgeTypes = { handoff: HandoffEdge };
function FlowViewport({
  team,
  selection,
  setSelection,
  onConnect,
  onMove,
  onEdgeEdit,
  fitKey,
  onDropRole,
}) {
  const [nodes, setNodes] = useState(() => applyLayout(team.nodes, selection));
  const instance = useRef(null);
  useEffect(() => {
    setNodes(applyLayout(team.nodes, selection));
  }, [team.nodes, selection]);
  useEffect(() => {
    instance.current?.fitView({ padding: 0.16, maxZoom: 1.15, duration: 180 });
  }, [fitKey]);
  const edges = useMemo(
    () =>
      team.edges.flatMap((e, index) => {
        const from = team.nodes.find((n) => n.id === e.from),
          to = team.nodes.find((n) => n.id === e.to);
        if (!from || !to) return [];
        const returnPath = team.edges
          .slice(0, index)
          .some(
            (prev) =>
              (prev.from === e.to && prev.to === e.from) ||
              (prev.from === e.from && prev.to === e.to),
          );
        const [sourceHandle, targetHandle] = returnPath
            ? Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
              ? ["top", "top"]
              : ["right", "right"]
            : flowPorts(from, to),
          manual = e.mode === "manual";
        return [
          {
            id: e.id,
            source: e.from,
            target: e.to,
            sourceHandle,
            targetHandle,
            type: "handoff",
            data: { returnPath },
            label: e.label,
            interactionWidth: 18,
            labelStyle: { fill: "#43535d", fontSize: 11 },
            labelBgStyle: { fill: "#f7f8f7", fillOpacity: 0.95 },
            labelBgPadding: [4, 2],
            labelBgBorderRadius: 3,
            style: {
              stroke: manual ? "#475dc5" : "#60796f",
              strokeWidth: 1.7,
              strokeDasharray: manual ? "5 4" : undefined,
            },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              width: 14,
              height: 14,
              color: manual ? "#475dc5" : "#60796f",
            },
          },
        ];
      }),
    [team.nodes, team.edges],
  );
  return (
    <ReactFlow
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        e.preventDefault();
        const kind = e.dataTransfer.getData("application/x-ohoo-role");
        if (instance.current && ["agent", "human"].includes(kind)) {
          const pos = instance.current.screenToFlowPosition({
            x: e.clientX,
            y: e.clientY,
          });
          onDropRole(kind, { x: Math.round(pos.x), y: Math.round(pos.y) });
        }
      }}
      nodes={nodes}
      edges={edges}
      edgeTypes={edgeTypes}
      nodeTypes={nodeTypes}
      connectionMode={ConnectionMode.Loose}
      onInit={(rf) => {
        instance.current = rf;
      }}
      onNodesChange={(changes) =>
        setNodes((ns) => applyNodeChanges(changes, ns))
      }
      onNodeClick={(_, n) => setSelection(n.id)}
      onNodeDragStop={(_, n) => onMove(n.id, n.position)}
      onConnect={(c) => onConnect(c.source, c.target)}
      onEdgeClick={(_, e) => onEdgeEdit(e.id)}
      fitView
      fitViewOptions={{ padding: 0.16, maxZoom: 1.15 }}
      minZoom={0.24}
      maxZoom={2}
      nodesConnectable
      nodesDraggable
      deleteKeyCode={null}
      panOnScroll
      panOnDrag
      zoomOnDoubleClick={false}
    >
      <Background gap={20} size={1} color="#bdc5c8" />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  );
}
function RoleInspector({
  role,
  team,
  ws,
  onEdit,
  onRemove,
  onEdge,
  onOpenRun,
  onAddEdge,
}) {
  if (!role)
    return (
      <aside className="td-inspector">
        <div className="td-ins-head">
          <h3>角色属性</h3>
          <Settings2 size={16} />
        </div>
        <div className="td-ins-body">
          <p>添加角色后，在这里配置职责与交付产物。</p>
        </div>
      </aside>
    );
  const env = ws.envs.find((e) => e.id === role.envId),
    provider = env?.providers?.find((p) => providerName(p) === role.provider),
    human = role.kind === "human",
    Icon = human ? UserRound : Terminal;
  const related = team.edges.filter(
    (e) => e.from === role.id || e.to === role.id,
  );
  const rows = [
    ["负责成员", role.owner],
    ["交付产物", role.output],
    ["必填字段", role.fields?.join("、")],
    ...(!human
      ? [
          ["执行环境", env?.name || "待绑定"],
          ["执行器", role.provider || "待绑定"],
          ["模型", role.model || "执行器默认"],
          ["工作目录", role.cwd],
        ]
      : []),
  ].filter(([, v]) => v);
  function chips(title, items) {
    if (!items?.length) return null;
    return (
      <div className="td-chip-section">
        <h4>{title}</h4>
        <div className="td-chips">
          {items.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </div>
    );
  }
  return (
    <aside className="td-inspector">
      <div className="td-ins-head">
        <h3>角色属性</h3>
        <button
          className="td-icon"
          type="button"
          onClick={onEdit}
          aria-label={"编辑" + role.name}
        >
          <Pencil size={16} />
        </button>
      </div>
      <div className="td-ins-body">
        <div className="td-node-hero">
          <span className={`td-ins-icon ${human ? "is-human" : ""}`}>
            <Icon size={20} />
          </span>
          <div>
            <small>{human ? "真人角色" : "Agent 节点"}</small>
            <h3>{role.name}</h3>
          </div>
        </div>
        <p className="td-duty">{role.duty || "待填写职责"}</p>
        <Button onClick={onOpenRun}>
          <Play size={14} />
          进入角色工作
        </Button>
        <dl className="td-props">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        {!human &&
          (!env ||
            !provider ||
            env.status === "离线" ||
            provider.status !== "已验证") && (
            <p className="td-binding-hint">
              <CircleAlert size={14} />
              {!env || !provider
                ? "执行绑定待配置。"
                : `${env.status} · ${provider.status}，启动前需核对。`}
            </p>
          )}
        {!human && (
          <>
            {chips("Skills", role.skills)}
            {chips("业务 CLI", role.clis)}
          </>
        )}
        <div className="td-handoffs">
          <div className="td-section-title">
            <h4>关联交接</h4>
            <button
              className="td-icon"
              type="button"
              disabled={team.nodes.length < 2}
              aria-label="为此角色新增交接"
              onClick={onAddEdge}
            >
              <Plus size={15} />
            </button>
          </div>
          {related.length ? (
            related.map((e) => {
              const out = e.from === role.id,
                other = team.nodes.find((n) => n.id === (out ? e.to : e.from));
              return (
                <button key={e.id} type="button" onClick={() => onEdge(e.id)}>
                  <span>
                    <strong>
                      {out ? "交给" : "接自"} {other?.name}
                    </strong>
                    <small>
                      {e.label} · {e.mode === "manual" ? "人工" : "自动"}
                    </small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              );
            })
          ) : (
            <p>尚未配置交接。</p>
          )}
        </div>
        <div className="td-ins-actions">
          <Button onClick={onEdit}>
            <Pencil size={14} />
            编辑角色
          </Button>
          <button
            type="button"
            className="td-link td-danger"
            onClick={onRemove}
          >
            <Trash2 size={13} />
            移除
          </button>
        </div>
      </div>
    </aside>
  );
}
function RoleList({ team, selection, onSelect, onEdit, onEdge }) {
  return (
    <div className="td-list-view">
      <h3>角色</h3>
      {team.nodes.map((n) => (
        <div
          className={`td-role-row ${n.id === selection ? "is-selected" : ""}`}
          key={n.id}
        >
          <button type="button" onClick={() => onSelect(n.id)}>
            {n.kind === "human" ? (
              <UserRound size={17} />
            ) : (
              <Terminal size={17} />
            )}
            <span>
              <strong>{n.name}</strong>
              <small>
                {n.owner || "未指派"} ·{" "}
                {n.kind === "human" ? "真人" : n.provider || "待绑定"}
              </small>
            </span>
          </button>
          <button
            type="button"
            className="td-icon"
            aria-label={"编辑" + n.name}
            onClick={() => onEdit(n.id)}
          >
            <Pencil size={15} />
          </button>
        </div>
      ))}
      <h3>交接规则</h3>
      {team.edges.length ? (
        team.edges.map((e) => (
          <button
            type="button"
            className="td-edge-row"
            key={e.id}
            onClick={() => onEdge(e.id)}
          >
            <GitBranch size={15} />
            <span>
              <strong>
                {team.nodes.find((n) => n.id === e.from)?.name} →{" "}
                {team.nodes.find((n) => n.id === e.to)?.name}
              </strong>
              <small>
                {e.label} · {e.mode === "manual" ? "人工" : "自动"}
              </small>
            </span>
            <ChevronRight size={14} />
          </button>
        ))
      ) : (
        <p>尚未配置交接。</p>
      )}
    </div>
  );
}
function TeamDesigner({ team }) {
  const { ws, user, nav, updateTeam, toast, launch } = useStudio();
  const [selected, setSelected] = useState(team.nodes[0]?.id || ""),
    [layout, setLayout] = useState(() =>
      window.matchMedia("(max-width:760px)").matches ? "list" : "graph",
    ),
    [modal, setModal] = useState(null),
    [palette, setPalette] = useState(false),
    [fitKey, setFitKey] = useState(0);
  const paletteRef = useRef(null),
    selectedRole = team.nodes.find((n) => n.id === selected) || team.nodes[0];
  useEffect(() => {
    if (!palette) return;
    const close = (e) => {
      if (!paletteRef.current?.contains(e.target)) setPalette(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [palette]);
  function change(fn) {
    updateTeam((t) => {
      fn(t);
      t.dirty = true;
    }, team.id);
  }
  function addRole(kind = "agent", position = uniquePositions(team.nodes)) {
    setPalette(false);
    setModal({
      kind: "role",
      new: true,
      value: {
        id: uid(),
        kind,
        name: "",
        owner: team.members?.includes(user) ? user : team.members?.[0] || user,
        duty: "",
        skills: [],
        clis: [],
        envId: "",
        provider: "",
        model: "",
        cwd: "",
        output: "",
        fields: [],
        action: kind === "human" ? "review" : "work",
        ...position,
      },
    });
  }
  function editRole(id) {
    const n = team.nodes.find((n) => n.id === id);
    if (n) {
      setSelected(id);
      setModal({ kind: "role", value: clone(n) });
    }
  }
  function onSaveRole(n) {
    change((t) => {
      const at = t.nodes.findIndex((node) => node.id === n.id);
      if (at < 0) t.nodes.push(n);
      else t.nodes[at] = n;
    });
    setSelected(n.id);
    setModal(null);
    if (modal?.new) setFitKey((k) => k + 1);
    toast("角色已保存到草稿");
  }
  function newEdge(
    from = selectedRole?.id,
    to = team.nodes.find((n) => n.id !== from)?.id,
  ) {
    if (!from || !to || from === to) {
      toast("请连接两个不同的角色");
      return;
    }
    setModal({
      kind: "edge",
      new: true,
      value: { id: uid(), from, to, label: "", mode: "auto" },
    });
  }
  function editEdge(id) {
    const edge = team.edges.find((e) => e.id === id);
    if (edge) setModal({ kind: "edge", value: clone(edge) });
  }
  function saveEdge(edge) {
    change((t) => {
      const index = t.edges.findIndex((e) => e.id === edge.id);
      if (index < 0) t.edges.push(edge);
      else t.edges[index] = edge;
    });
    setModal(null);
    toast("交接已保存");
  }
  function runRole() {
    if (!selectedRole) return;
    const matches = team.runs.filter((r) =>
      r.nodes?.some((n) => n.id === selectedRole.id),
    );
    const pending = matches.filter(
      (r) =>
        r.current === selectedRole.id &&
        !["已完成", "已关闭"].includes(r.status),
    );
    if (pending.length === 1) {
      nav("session", {
        teamId: team.id,
        runId: pending[0].id,
        nodeId: selectedRole.id,
      });
      return;
    }
    if (!matches.length) {
      if (!team.published?.nodes.some((n) => n.id === selectedRole.id)) {
        toast("此角色尚未发布，发布草稿后才能发起角色工作。");
        return;
      }
      launch(team.id);
      return;
    }
    setModal({ kind: "runs", role: selectedRole.id });
  }
  const validate = () => validateTeam(team, ws);
  function publish() {
    const result = validate();
    if (result.errors.length) {
      setModal({ kind: "check", result });
      return;
    }
    const version = (Number(team.version) || 0) + 1;
    updateTeam((t) => {
      t.version = version;
      t.published = {
        version,
        name: t.name,
        goal: t.goal,
        finish: t.finish,
        template: t.template,
        nodes: clone(t.nodes),
        edges: clone(t.edges),
      };
      t.dirty = false;
    }, team.id);
    setModal(null);
    toast(`已发布流程 v${version}`);
  }
  return (
    <section className="td-page td-designer">
      <nav className="td-breadcrumb">
        <button
          type="button"
          onClick={() =>
            nav("teams", { teamId: null, runId: null, nodeId: null })
          }
        >
          团队目录
        </button>
        <ChevronRight size={13} />
        <span>流程设计器</span>
      </nav>
      <header className="td-head">
        <div className="td-heading">
          <h1>{team.name}</h1>
          <p>{team.goal}</p>
        </div>
        <div className="td-head-actions">
          <Button onClick={() => setModal({ kind: "settings" })}>
            <Settings2 size={15} />
            团队设置
          </Button>
          <Button onClick={() => launch(team.id)} disabled={!team.published}>
            <Play size={15} />
            发起运行
          </Button>
          <Button
            variant="primary"
            disabled={!team.dirty && !!team.published}
            onClick={() => setModal({ kind: "publish", result: validate() })}
          >
            <GitBranch size={15} />
            发布流程
          </Button>
        </div>
      </header>
      <div className="td-bar">
        <div className="td-view-switch" aria-label="画布显示方式">
          <button
            type="button"
            aria-pressed={layout === "graph"}
            onClick={() => setLayout("graph")}
          >
            <Workflow size={15} />
            流程图
          </button>
          <button
            type="button"
            aria-pressed={layout === "list"}
            onClick={() => setLayout("list")}
          >
            <List size={15} />
            角色列表
          </button>
        </div>
        <div className="td-bar-actions">
          <Badge tone={team.published && !team.dirty ? "green" : "amber"}>
            {statusOf(team)}
          </Badge>
          <span className="td-version">{versionOf(team)}</span>
          <Button
            variant="ghost"
            onClick={() => setModal({ kind: "check", result: validate() })}
          >
            <ShieldCheck size={15} />
            校验草稿
          </Button>
        </div>
      </div>
      <div className="td-editor-grid">
        <div className="td-flow-frame">
          <div className="td-flow-head">
            <h2>
              <Network size={17} />
              团队流程
            </h2>
            <div className="td-canvas-tools">
              <div ref={paletteRef} className="td-palette-wrap">
                <Button
                  onClick={() => setPalette((v) => !v)}
                  aria-expanded={palette}
                >
                  <Plus size={15} />
                  添加角色
                </Button>
                {palette && (
                  <div className="td-palette">
                    <small>点击添加，或拖到图上</small>
                    {[
                      ["agent", "Agent 角色", Bot],
                      ["human", "真人角色", UserRound],
                    ].map(([kind, label, Icon]) => (
                      <button
                        key={kind}
                        type="button"
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData(
                            "application/x-ohoo-role",
                            kind,
                          );
                          e.dataTransfer.effectAllowed = "copy";
                        }}
                        onClick={() => addRole(kind)}
                      >
                        <Grip size={14} />
                        <Icon size={16} />
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <Button
                disabled={team.nodes.length < 2}
                onClick={() => newEdge()}
              >
                <GitBranch size={15} />
                添加交接
              </Button>
            </div>
          </div>
          {!team.nodes.length ? (
            <div
              className="td-empty td-empty-canvas"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const kind = e.dataTransfer.getData("application/x-ohoo-role");
                if (["human", "agent"].includes(kind)) addRole(kind);
              }}
            >
              <Workflow size={31} />
              <h3>添加第一个角色</h3>
              <p>定义角色职责与产物，再决定下一步由谁接手。</p>
              <Button onClick={() => addRole()}>
                <Plus size={15} />
                添加 Agent 角色
              </Button>
            </div>
          ) : layout === "graph" ? (
            <div className="td-flow-stage">
              <FlowViewport
                team={team}
                selection={selectedRole?.id}
                setSelection={setSelected}
                onConnect={newEdge}
                onEdgeEdit={editEdge}
                onMove={(id, pos) =>
                  change((t) => {
                    const n = t.nodes.find((n) => n.id === id);
                    if (n)
                      Object.assign(n, {
                        x: Math.round(pos.x),
                        y: Math.round(pos.y),
                      });
                  })
                }
                fitKey={fitKey}
                onDropRole={addRole}
              />
            </div>
          ) : (
            <RoleList
              team={team}
              selection={selectedRole?.id}
              onSelect={setSelected}
              onEdit={editRole}
              onEdge={editEdge}
            />
          )}
          <div className="td-flow-foot">
            <span>
              {team.nodes.length} 个角色 · {team.edges.length} 条交接
            </span>
            <span className="td-line-key">
              <i />
              自动交接 <i className="manual" />
              人工转交
            </span>
          </div>
        </div>
        <RoleInspector
          role={selectedRole}
          team={team}
          ws={ws}
          onEdit={() => editRole(selectedRole.id)}
          onRemove={() => setModal({ kind: "remove", role: selectedRole })}
          onEdge={editEdge}
          onAddEdge={() => newEdge()}
          onOpenRun={runRole}
        />
      </div>
      {modal?.kind === "role" && (
        <Modal
          title={modal.new ? "创建角色" : "编辑角色"}
          onClose={() => setModal(null)}
        >
          <RoleForm
            role={modal.value}
            team={team}
            ws={ws}
            onSave={onSaveRole}
            onCancel={() => setModal(null)}
          />
        </Modal>
      )}
      {modal?.kind === "edge" && (
        <Modal
          title={modal.new ? "添加交接" : "编辑交接"}
          onClose={() => setModal(null)}
        >
          <EdgeForm
            edge={modal.value}
            team={team}
            onSave={saveEdge}
            onCancel={() => setModal(null)}
          />
          {!modal.new && (
            <button
              type="button"
              className="td-link td-danger"
              onClick={() => {
                change((t) => {
                  t.edges = t.edges.filter((x) => x.id !== modal.value.id);
                });
                setModal(null);
                toast("交接已从草稿移除");
              }}
            >
              <Trash2 size={14} />
              移除交接
            </button>
          )}
        </Modal>
      )}
      {modal?.kind === "settings" && (
        <Modal title="团队设置" onClose={() => setModal(null)}>
          <TeamForm
            team={team}
            ws={ws}
            user={user}
            onCancel={() => setModal(null)}
            onSave={(v) => {
              change((t) =>
                Object.assign(t, {
                  name: v.name,
                  goal: v.goal,
                  owner: v.owner,
                  finish: v.finish,
                  members: v.members,
                }),
              );
              setModal(null);
              toast("团队设置已保存");
            }}
          />
        </Modal>
      )}
      {modal?.kind === "remove" && (
        <Modal title="移除角色" onClose={() => setModal(null)}>
          <p>
            从团队草稿移除「{modal.role.name}
            」及相关交接？已启动的运行将保留原角色。
          </p>
          <div className="td-form-foot">
            <Button onClick={() => setModal(null)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                const id = modal.role.id;
                change((t) => {
                  t.nodes = t.nodes.filter((n) => n.id !== id);
                  t.edges = t.edges.filter((e) => e.from !== id && e.to !== id);
                });
                setSelected("");
                setModal(null);
                toast("角色已从草稿移除");
              }}
            >
              移除角色
            </Button>
          </div>
        </Modal>
      )}
      {["check", "publish"].includes(modal?.kind) && (
        <Modal
          title={
            modal.result.errors.length
              ? "草稿需要补充"
              : modal.kind === "publish"
                ? `发布流程 v${Number(team.version) + 1}`
                : "流程校验通过"
          }
          onClose={() => setModal(null)}
        >
          <div className="td-validation">
            <p>
              {modal.result.errors.length
                ? "修改以下项目后，再次校验。"
                : modal.kind === "publish"
                  ? "发布后，新运行使用这个版本。已有运行继续使用启动时的流程。"
                  : `${team.nodes.length} 个角色、${team.edges.length} 条交接已完成校验。`}
            </p>
            {modal.result.errors.map((msg, i) => (
              <p className="td-form-error" key={i}>
                <CircleAlert size={14} /> {msg}
              </p>
            ))}
            {modal.result.warnings.map((msg, i) => (
              <p className="td-binding-hint" key={i}>
                <CircleAlert size={14} /> {msg}
              </p>
            ))}
          </div>
          <div className="td-form-foot">
            <Button onClick={() => setModal(null)}>返回画布</Button>
            {!modal.result.errors.length && modal.kind === "publish" && (
              <Button variant="primary" onClick={publish}>
                确认发布 v{Number(team.version) + 1}
              </Button>
            )}
          </div>
        </Modal>
      )}
      {modal?.kind === "runs" && (
        <Modal title="选择角色运行" onClose={() => setModal(null)}>
          <div className="td-runs">
            {team.runs
              .filter((r) => r.nodes.some((n) => n.id === modal.role))
              .map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() =>
                    nav("session", {
                      teamId: team.id,
                      runId: r.id,
                      nodeId: modal.role,
                    })
                  }
                >
                  <span>
                    {r.title}
                    <small>
                      {r.id} · v{r.version}
                    </small>
                  </span>
                  <Badge>{r.status}</Badge>
                  <ChevronRight size={14} />
                </button>
              ))}
          </div>
          <div className="td-form-foot">
            <Button
              onClick={() => {
                setModal(null);
                launch(team.id);
              }}
            >
              <Play size={14} />
              发起新运行
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
export function Teams() {
  const { ws, team, route } = useStudio();
  return route.page === "canvas" && team ? (
    <TeamDesigner key={`${ws.id}:${team.id}`} team={team} />
  ) : (
    <TeamsDirectory key={ws.id} />
  );
}
