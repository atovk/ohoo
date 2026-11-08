import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  Boxes,
  GitPullRequest,
  FlaskConical,
  ArrowUp,
  ChevronRight,
  CircleAlert,
  GripVertical,
  Plus,
  Save,
  TerminalSquare,
  Trash2,
  UserRound,
  Workflow,
} from "lucide-react";
import { api } from "../api";

const listText = (values) => (values || []).join("，");
const splitList = (text) => [
  ...new Set(
    (text || "")
      .split(/[,，;；、\n]+/)
      .map((v) => v.trim())
      .filter(Boolean),
  ),
];
const releaseExample = {
  files: [
    "orders.mjs",
    "orders.test.mjs",
    "orders-http.mjs",
    "acceptance.test.mjs",
    "team-release.mjs",
    "test-environment.mjs",
  ],
  test: ["node", "--test", "orders.test.mjs", "acceptance.test.mjs"],
  deploy: ["node", "team-release.mjs", "deploy"],
  verify: ["node", "team-release.mjs", "verify"],
  target: "orders-test",
};
function deliveryForm(policy) {
  if (policy?.kind === "qa")
    return {
      kind: "qa",
      files: (policy.files || []).join("\n"),
      test: JSON.stringify(policy.test || []),
      maxRepairs: policy.maxRepairs ?? 2,
    };
  if (policy?.kind === "release")
    return {
      kind: "release",
      target: policy.target || "",
      deploy: JSON.stringify(policy.deploy || []),
      verify: JSON.stringify(policy.verify || []),
    };
  return null;
}
function parseCommand(text, label) {
  let argv;
  try {
    argv = JSON.parse(text);
  } catch {
    throw new Error(`${label}需要合法的 JSON 字符串数组。`);
  }
  if (
    !Array.isArray(argv) ||
    !argv.length ||
    argv.length > 128 ||
    argv.some(
      (a) => typeof a !== "string" || a.length > 8192 || a.includes("\0"),
    ) ||
    !argv[0].trim()
  )
    throw new Error(`${label}需包含可执行程序和独立的字符串参数。`);
  return argv;
}
function deliveryPolicy(role) {
  const d = role.delivery;
  if (role.kind !== "agent" || !d) return undefined;
  if (d.kind === "qa") {
    const files = [
      ...new Set(
        d.files
          .split(/\r?\n/)
          .map((f) => f.trim())
          .filter(Boolean),
      ),
    ];
    if (
      !files.length ||
      files.length > 128 ||
      files.some(
        (f) =>
          f.length > 1024 ||
          /^[a-z]:/i.test(f) ||
          f.includes("\\") ||
          f.includes("\0") ||
          f.split("/").some((part) => !part || part === "." || part === ".."),
      )
    )
      throw new Error(
        `${role.name || "QA 角色"}需要工作目录内的候选文件相对路径，每行一个。`,
      );
    const maxRepairs = Number(d.maxRepairs);
    if (
      String(d.maxRepairs).trim() === "" ||
      !Number.isInteger(maxRepairs) ||
      maxRepairs < 0 ||
      maxRepairs > 20
    )
      throw new Error("最大修复次数需为 0 到 20 的整数。");
    return {
      kind: "qa",
      files,
      maxRepairs,
      test: parseCommand(d.test, "测试命令"),
    };
  }
  if (d.kind === "release") {
    if (!d.target.trim()) throw new Error("填写测试发布的目标环境名称。");
    return {
      kind: "release",
      target: d.target.trim(),
      deploy: parseCommand(d.deploy, "部署命令"),
      verify: parseCommand(d.verify, "部署后验证命令"),
    };
  }
}
function deliveryRoleIds(roles) {
  const ids = new Set();
  roles.forEach((r, i) => {
    if (!r.delivery) return;
    ids.add(r.id);
    if (r.delivery.kind === "qa" && roles[i - 1]?.kind === "agent")
      ids.add(roles[i - 1].id);
  });
  return ids;
}
function fromRole(r) {
  return {
    ...r,
    delivery: deliveryForm(r.delivery),
    skills: listText(r.skills),
    clis: listText(r.clis),
    requiredFields: listText(r.requiredFields),
  };
}
function blankRole(kind, assigneeId, cwd) {
  return {
    id: crypto.randomUUID(),
    name: "",
    kind,
    assigneeId,
    duty: "",
    skills: "",
    clis: "",
    environmentId: kind === "agent" ? "local" : "",
    provider: "",
    model: "",
    cwd: kind === "agent" ? cwd || "" : "",
    output: "",
    requiredFields: "",
    autoStartOnHandoff: false,
    reviewMode: "standard",
    delivery: null,
  };
}
function serializeRole(r) {
  const human = r.kind === "human";
  return {
    id: r.id,
    name: r.name.trim(),
    kind: r.kind,
    assigneeId: r.assigneeId,
    duty: r.duty.trim(),
    environmentId: human ? "" : "local",
    provider: human ? "" : r.provider,
    model: human ? "" : r.model,
    cwd: human ? "" : r.cwd.trim(),
    skills: human ? [] : splitList(r.skills),
    clis: human ? [] : splitList(r.clis),
    output: r.output.trim(),
    requiredFields: splitList(r.requiredFields),
    ...(human
      ? { reviewMode: r.reviewMode || "standard" }
      : {
          autoStartOnHandoff: r.autoStartOnHandoff === true,
          delivery: deliveryPolicy(r),
        }),
  };
}
const designTemplate = {
  name: "需求与研发设计组",
  goal: "整理需求、形成技术设计，由负责人确认批准版本并据此开展实施。",
};
function makeDesignRoles(ownerId, cwd) {
  const agent = () => ({
    ...blankRole("agent", ownerId, cwd),
    suggestBinding: true,
  });
  return [
    {
      ...agent(),
      name: "需求整理",
      duty: "整理成员提供的需求材料，写清范围、约束、验收条件及待确认问题。",
      output: "需求说明",
    },
    {
      ...agent(),
      name: "开发设计",
      duty: "根据接收的需求说明和实际仓库起草技术方案，列出影响、实现步骤和验证办法。仅在负责人明确确认开工后，按批准版本实施并提交结果。",
      output: "技术方案或实施产物",
      autoStartOnHandoff: true,
    },
    {
      ...blankRole("human", ownerId, ""),
      name: "开发负责人",
      duty: "评审核心设计、编辑方案或退回修订。确认开工时指定批准版本，开发实施后核查交付结果。",
      output: "评审决定",
      reviewMode: "design",
    },
  ];
}
const deliveryTemplate = {
  name: "测试发布组",
  goal: "围绕同一候选版本完成开发、测试修复、测试环境部署与验证。",
};
function makeDeliveryRoles(ownerId, cwd) {
  const agent = () => ({
    ...blankRole("agent", ownerId, cwd),
    suggestBinding: true,
    autoStartOnHandoff: true,
  });
  return [
    {
      ...agent(),
      name: "开发实现",
      duty: "在团队指定工作目录完成实现，并提交本次候选文件。收到 QA 失败回执时，依据实际错误修复并提交新版候选。",
      output: "候选版本",
    },
    {
      ...agent(),
      name: "QA 验证",
      duty: "检查提交的候选版本与真实测试回执。用失败证据退回修复，测试通过才交付 SRE。",
      output: "测试报告",
      delivery: deliveryForm({
        kind: "qa",
        files: releaseExample.files,
        test: releaseExample.test,
        maxRepairs: 2,
      }),
    },
    {
      ...agent(),
      name: "SRE 测试发布",
      duty: "在指定测试环境发布 QA 通过的同一候选，分别核对部署回执和验证回执。",
      output: "部署与验证回执",
      delivery: deliveryForm({
        kind: "release",
        target: releaseExample.target,
        deploy: releaseExample.deploy,
        verify: releaseExample.verify,
      }),
    },
  ];
}
function suggestTemplateBindings(roles, discovery) {
  if (!discovery?.environment?.cwd) return roles;
  const available = (discovery.online ? discovery.providers || [] : []).filter(
    (p) => p.available !== false && p.models?.length,
  );
  const cwd = discovery.environment.cwd;
  return roles.map((r) => {
    if (
      !r.suggestBinding ||
      (r.cwd && r.cwd !== cwd && r.cwd !== discovery.requestedCwd)
    )
      return r;
    const provider =
      available.find((p) => p.id === r.preferredProvider) ||
      available.find((p) => p.id.toLowerCase() === "codex") ||
      available[0];
    if (!provider) return r.cwd ? r : { ...r, cwd };
    const model = (
      provider.models.find((m) => m.isDefault) || provider.models[0]
    ).id;
    return { ...r, cwd, provider: provider.id, model, suggestBinding: false };
  });
}

function verifyRoles(roles, members, catalogs, original) {
  if (roles.length < 2) return "至少添加两个角色，才能建立交接。";
  const membersOfDelivery = deliveryRoleIds(roles),
    dirs = new Set(
      roles
        .filter((n) => membersOfDelivery.has(n.id))
        .map((n) => catalogs[n.cwd]?.environment?.cwd || n.cwd),
    );
  if (dirs.size > 1)
    return "开发、QA 和 SRE 的工作目录需要一致，请先应用共享工作目录。";
  for (let i = 0; i < roles.length; i++) {
    const r = roles[i],
      name = r.name || `第 ${i + 1} 个角色`;
    if (!r.name || !r.duty || !r.output)
      return `${name}需要名称、职责和交付产物。`;
    if (!members.includes(r.assigneeId)) return `请为${name}选择一位团队成员。`;
    if (r.reviewMode === "design" && roles[i - 1]?.kind !== "agent")
      return `${name}的上一个角色须为提交技术方案的 agent。`;
    if (
      r.delivery?.kind === "qa" &&
      (roles[i - 1]?.kind !== "agent" ||
        roles[i - 1]?.delivery ||
        roles[i + 1]?.delivery?.kind !== "release")
    )
      return `${name}需紧接普通开发 Agent，下一角色须配置 SRE 发布。`;
    if (
      r.delivery?.kind === "release" &&
      (roles[i - 1]?.delivery?.kind !== "qa" || i !== roles.length - 1)
    )
      return `${name}须紧接 QA 且是最后的角色。`;
    if (r.delivery && !r.autoStartOnHandoff)
      return `${name}需要开启收到上游产物后自动启动。`;
    if (r.kind === "agent") {
      if (!r.provider || !r.cwd)
        return `${name}需要工作目录与本机发现的执行器。`;
      const before = original?.roles.find((old) => old.id === r.id),
        known = catalogs[r.cwd],
        pr = known?.providers?.find((p) => p.id === r.provider);
      const unchanged =
        before?.cwd === r.cwd && before?.provider === r.provider;
      if ((!pr || pr.available === false) && !unchanged)
        return `${name}需要在其工作目录检测并绑定可用的执行器。`;
      if (
        pr &&
        r.model &&
        !pr.models?.some((m) => m.id === r.model) &&
        before?.model !== r.model
      )
        return `${name}所选的模型目前未被发现。`;
    }
  }
  return "";
}
function Labeled({ title, children }) {
  return (
    <label className="wb-field">
      <span>{title}</span>
      {React.cloneElement(children, { "aria-label": title })}
    </label>
  );
}
export default function TeamEditor({
  team: latestTeam,
  user,
  members,
  discovery,
  onSave,
  onCancel,
  onDiscover,
}) {
  const [team] = useState(() => latestTeam);
  const stale = Boolean(team && latestTeam?.version !== team.version);
  const [name, setName] = useState(team?.name || ""),
    [goal, setGoal] = useState(team?.goal || "");
  const [memberIds, setMemberIds] = useState(
    () => team?.memberIds?.slice() || [user.id],
  );
  const [roles, setRoles] = useState(() => team?.roles?.map(fromRole) || []),
    [selected, setSelected] = useState(team?.roles?.[0]?.id || null);
  const [removeId, setRemoveId] = useState(null),
    [dragging, setDragging] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [template, setTemplate] = useState("blank"),
    [replaceWith, setReplaceWith] = useState(null);
  const [sharedDraft, setSharedDraft] = useState(null),
    [sharing, setSharing] = useState(false),
    [sharedNotice, setSharedNotice] = useState("");
  const sharedIds = deliveryRoleIds(roles),
    sharedRoles = roles.filter((r) => sharedIds.has(r.id)),
    sharedCwd = sharedDraft ?? sharedRoles[0]?.cwd ?? "";
  const active = roles.find((r) => r.id === selected),
    env = discovery?.environment;
  const [catalogs, setCatalogs] = useState({});
  useEffect(() => {
    if (!discovery?.environment?.cwd) return;
    const cwd = discovery.environment.cwd;
    setCatalogs((cache) => ({
      ...cache,
      [cwd]: discovery,
      [discovery.requestedCwd || cwd]: discovery,
    }));
  }, [discovery]);
  useEffect(() => {
    if (!team && template !== "blank" && discovery?.environment) {
      setRoles((current) =>
        current.some((r) => r.suggestBinding)
          ? suggestTemplateBindings(current, discovery)
          : current,
      );
    }
  }, [team, template, discovery]);
  function applyTemplate(next) {
    const config =
      next === "design"
        ? designTemplate
        : next === "delivery"
          ? deliveryTemplate
          : null;
    const factory = next === "design" ? makeDesignRoles : makeDeliveryRoles;
    const generated = config
      ? suggestTemplateBindings(factory(user.id, env?.cwd || ""), discovery)
      : [];
    if (!name || [designTemplate.name, deliveryTemplate.name].includes(name))
      setName(config?.name || "");
    if (!goal || [designTemplate.goal, deliveryTemplate.goal].includes(goal))
      setGoal(config?.goal || "");
    setRoles(generated);
    setSelected(generated[0]?.id || null);
    setTemplate(next);
    setReplaceWith(null);
    setRemoveId(null);
    setError("");
    setSharedDraft(null);
    setSharedNotice("");
  }
  function chooseTemplate(next) {
    if (next === template) return;
    if (roles.length) {
      setReplaceWith(next);
      return;
    }
    applyTemplate(next);
  }
  async function loadCatalog(cwd) {
    const result = await onDiscover(cwd);
    const canonical = result?.environment?.cwd;
    if (canonical) {
      setCatalogs((previous) => ({
        ...previous,
        [canonical]: result,
        [result.requestedCwd || canonical]: result,
      }));
      if (!team && template !== "blank")
        setRoles((current) => suggestTemplateBindings(current, result));
    } else if (cwd) {
      setCatalogs((previous) => {
        const next = { ...previous };
        delete next[cwd];
        return next;
      });
    }
  }
  async function applySharedDirectory() {
    const cwd = sharedCwd.trim();
    if (!cwd) {
      setSharedNotice("请填写共同工作目录。");
      return;
    }
    setSharing(true);
    setSharedNotice("");
    try {
      const d = await onDiscover(cwd);
      if (
        !d?.online ||
        !d.providers.some((p) => p.available !== false && p.models?.length)
      ) {
        setSharedNotice(d?.error || "该目录未发现可用的执行器，保留原绑定。");
        return;
      }
      const actual = d.environment.cwd;
      setCatalogs((prev) => ({ ...prev, [cwd]: d, [actual]: d }));
      setRoles((prev) =>
        suggestTemplateBindings(
          prev.map((r) =>
            sharedIds.has(r.id)
              ? {
                  ...r,
                  cwd: actual,
                  suggestBinding: true,
                  preferredProvider: r.provider || r.preferredProvider,
                }
              : r,
          ),
          d,
        ),
      );
      setSharedDraft(actual);
      setSharedNotice(`已检测并应用到 ${sharedIds.size} 个角色。`);
    } finally {
      setSharing(false);
    }
  }
  function changeDelivery(kind) {
    const policy =
      kind === "qa"
        ? deliveryForm({ kind: "qa", files: [], test: [], maxRepairs: 2 })
        : kind === "release"
          ? deliveryForm({
              kind: "release",
              target: "",
              deploy: [],
              verify: [],
            })
          : null;
    patch({
      delivery: policy,
      ...(policy ? { autoStartOnHandoff: true } : {}),
    });
    setSharedDraft(null);
    setSharedNotice("");
  }
  function patchDelivery(fields) {
    patch({ delivery: { ...active.delivery, ...fields } });
  }
  const catalog = catalogs[active?.cwd?.trim()],
    providers = catalog?.providers || [];
  const pr = providers.find((p) => p.id === active?.provider),
    readyProviders = providers.filter((p) => p.available !== false);
  useEffect(() => {
    if (
      active?.kind === "agent" &&
      active.cwd?.trim() &&
      !catalogs[active.cwd.trim()]
    )
      loadCatalog(active.cwd);
  }, [selected]);
  const tagged = useMemo(
    () => members.filter((m) => memberIds.includes(m.id)),
    [memberIds, members],
  );
  const person = (id) => members.find((m) => m.id === id)?.name || "未指派";
  function patch(fields) {
    setRoles((previous) =>
      previous.map((r) => {
        if (r.id !== selected) return r;
        const next = { ...r, ...fields };
        if ("cwd" in fields) {
          next.suggestBinding = !team && template !== "blank";
        } else if ("provider" in fields) {
          next.preferredProvider = fields.provider;
          next.suggestBinding = false;
        } else if ("model" in fields) {
          next.suggestBinding = false;
        }
        return next;
      }),
    );
  }
  function add(kind) {
    const owner = kind === "agent" ? user.id : tagged[0]?.id || user.id;
    const role = blankRole(kind, owner, env?.root || env?.cwd);
    setRoles((previous) => [...previous, role]);
    setSelected(role.id);
    setError("");
  }
  function move(id, targetIndex) {
    setRoles((previous) => {
      const from = previous.findIndex((r) => r.id === id);
      if (
        from < 0 ||
        targetIndex < 0 ||
        targetIndex >= previous.length ||
        targetIndex === from
      )
        return previous;
      const next = [...previous];
      next.splice(targetIndex, 0, next.splice(from, 1)[0]);
      return next;
    });
  }
  function remove() {
    const left = roles.filter((r) => r.id !== removeId);
    setRoles(left);
    if (selected === removeId) setSelected(left[0]?.id || null);
    setRemoveId(null);
  }
  async function save(e) {
    e.preventDefault();
    if (busy || stale || sharing) return;
    setError("");
    if (!name.trim() || !goal.trim()) {
      setError("填写团队名称和长期目标。");
      return;
    }
    if (
      sharedRoles.length &&
      sharedDraft !== null &&
      sharedRoles.some((r) => r.cwd !== sharedDraft.trim())
    ) {
      setError("请先检测并应用新的共享工作目录，再保存团队。");
      return;
    }
    let configured;
    try {
      configured = roles.map(serializeRole);
    } catch (err) {
      setError(err.message);
      return;
    }
    const payload = {
      name: name.trim(),
      goal: goal.trim(),
      memberIds,
      roles: configured,
    };
    const issue = verifyRoles(payload.roles, memberIds, catalogs, team);
    if (issue) {
      setError(issue);
      return;
    }
    setBusy(true);
    try {
      const saved = team
        ? await api(`/teams/${encodeURIComponent(team.id)}`, {
            method: "PUT",
            body: { ...payload, expectedVersion: team.version },
          })
        : await api("/teams", { method: "POST", body: payload });
      await onSave(saved);
    } catch (err) {
      setError(
        err.status === 409
          ? "团队版本已变更。返回团队详情重新打开编辑器，再应用你的修改。"
          : err.message,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="wb-team-editor wb-page" onSubmit={save}>
      <header className="wb-head">
        <div>
          <button type="button" className="wb-link" onClick={onCancel}>
            团队 <ChevronRight size={13} /> {team ? "流程设置" : "新团队"}
          </button>
          <h1>{team ? "编辑团队流程" : "创建团队"}</h1>
          <p>
            {team
              ? `当前流程 v${team.version}。保存后仅新的运行使用修改后的流程。`
              : "先定义长期分工，再配置角色之间的交接顺序。"}
          </p>
        </div>
        <div className="wb-actions">
          <button
            type="button"
            className="wb-btn"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            className="wb-btn wb-is-primary"
            disabled={busy || stale || sharing}
          >
            <Save size={15} />
            {busy ? "正在保存…" : team ? "保存新版本" : "创建团队"}
          </button>
        </div>
      </header>
      {stale && (
        <div className="wb-notice" role="status">
          <CircleAlert size={16} />
          新版 v{latestTeam.version}{" "}
          已保存。请返回团队详情重新打开编辑器，再应用本次修改。
        </div>
      )}
      {error && (
        <div className="wb-notice wb-error" role="alert">
          <CircleAlert size={17} />
          {error}
        </div>
      )}
      {!team && (
        <fieldset className="wb-template-picker">
          <legend>创建方式</legend>
          <div className="wb-template-options">
            <button
              type="button"
              className="wb-template-option"
              aria-pressed={template === "blank"}
              onClick={() => chooseTemplate("blank")}
            >
              <Boxes size={18} />
              <span>
                <strong>空白团队</strong>
                <small>自行添加 Agent、真人角色与交接顺序。</small>
              </span>
            </button>
            <button
              type="button"
              className="wb-template-option"
              aria-pressed={template === "design"}
              onClick={() => chooseTemplate("design")}
            >
              <GitPullRequest size={18} />
              <span>
                <strong>需求与研发设计评审</strong>
                <small>需求交给开发，负责人评审技术方案并确认开工。</small>
              </span>
            </button>
            <button
              type="button"
              className="wb-template-option"
              aria-pressed={template === "delivery"}
              onClick={() => chooseTemplate("delivery")}
            >
              <FlaskConical size={18} />
              <span>
                <strong>开发 → QA → SRE 测试发布</strong>
                <small>冻结候选、运行测试、部署并验证同一版本。</small>
              </span>
            </button>
          </div>
          {replaceWith && (
            <div className="wb-actions" role="status">
              <span>替换当前草稿的角色和交接顺序？</span>
              <button
                className="wb-btn"
                type="button"
                onClick={() => setReplaceWith(null)}
              >
                保留草稿
              </button>
              <button
                className="wb-btn wb-is-primary"
                type="button"
                onClick={() => applyTemplate(replaceWith)}
              >
                替换角色
              </button>
            </div>
          )}
          {template === "design" && (
            <div className="wb-template-route">
              <span>需求整理</span>
              <ArrowRight size={13} />
              <span>开发设计 · 自动接收</span>
              <ArrowRight size={13} />
              <span>开发负责人 · 确认开工</span>
            </div>
          )}
          {template === "delivery" && (
            <div className="wb-template-route">
              <span>开发 · 候选文件</span>
              <ArrowRight size={13} />
              <span>QA · 测试 / 退回</span>
              <ArrowRight size={13} />
              <span>SRE · 部署 / 验证</span>
            </div>
          )}
        </fieldset>
      )}
      <section className="wb-panel wb-form wb-team-basics">
        <div className="wb-section-title">
          <h2>团队信息</h2>
        </div>
        <div className="wb-form-row">
          <Labeled title="团队名称">
            <input
              autoFocus
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="为团队命名"
            />
          </Labeled>
          <Labeled title="长期目标">
            <input
              required
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="这个团队持续负责什么？"
            />
          </Labeled>
        </div>
        <fieldset className="wb-members">
          <legend>团队成员</legend>
          {members.map((m) => (
            <label key={m.id}>
              <input
                type="checkbox"
                checked={memberIds.includes(m.id)}
                disabled={m.id === user.id}
                onChange={(e) =>
                  setMemberIds((current) =>
                    e.target.checked
                      ? [...new Set([...current, m.id])]
                      : current.filter((id) => id !== m.id),
                  )
                }
              />
              {m.name}
            </label>
          ))}
        </fieldset>
      </section>
      {sharedRoles.length > 0 && (
        <section className="wb-panel wb-delivery-dir">
          <div className="wb-section-title">
            <h2>候选工作目录</h2>
          </div>
          <p className="wb-muted">
            开发、QA 和 SRE
            在同一目录中定义候选文件、测试与发布命令。示例命令可用于{" "}
            <code>npm run example:release</code> 输出的目录。
          </p>
          <div className="wb-actions">
            <Labeled title="共享工作目录">
              <input
                value={sharedCwd}
                onChange={(e) => {
                  setSharedDraft(e.target.value);
                  setSharedNotice("");
                }}
                placeholder={env?.root || "执行主机上的绝对路径"}
              />
            </Labeled>
            <button
              type="button"
              className="wb-btn"
              disabled={sharing || busy}
              onClick={applySharedDirectory}
            >
              {sharing ? "正在检测…" : "检测并应用到角色"}
            </button>
          </div>
          {sharedNotice && <small role="status">{sharedNotice}</small>}
        </section>
      )}
      <section className="wb-editor-grid">
        <div className="wb-panel wb-sequence">
          <div className="wb-section-title">
            <div>
              <h2>交接顺序</h2>
              <p>
                沿顺序交付产物。设计评审通过并确认开工后，回到提交方案的开发角色。
              </p>
            </div>
            <Workflow size={19} />
          </div>
          <div className="wb-role-list">
            {roles.map((r, i) => (
              <div
                key={r.id}
                className={`wb-role-row ${r.id === selected ? "wb-is-active" : ""}`}
                onDragOver={(e) => {
                  if (dragging) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragging) move(dragging, i);
                  setDragging(null);
                }}
              >
                <span
                  className="wb-grip"
                  draggable
                  aria-label="拖动调整顺序"
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", r.id);
                    e.dataTransfer.effectAllowed = "move";
                    setDragging(r.id);
                  }}
                  onDragEnd={() => setDragging(null)}
                >
                  <GripVertical size={15} />
                </span>
                <button
                  type="button"
                  className="wb-role-select"
                  onClick={() => {
                    setSelected(r.id);
                    setRemoveId(null);
                  }}
                >
                  {r.kind === "agent" ? (
                    <TerminalSquare size={16} />
                  ) : (
                    <UserRound size={16} />
                  )}
                  <span>
                    <strong>{r.name || "未命名角色"}</strong>
                    <small>
                      {person(r.assigneeId)} ·{" "}
                      {r.kind === "agent" ? "Agent" : "真人"}
                    </small>
                  </span>
                </button>
                <div className="wb-reorder">
                  <button
                    type="button"
                    aria-label={`${r.name || "角色"}上移`}
                    disabled={i === 0}
                    onClick={() => move(r.id, i - 1)}
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    type="button"
                    aria-label={`${r.name || "角色"}下移`}
                    disabled={i === roles.length - 1}
                    onClick={() => move(r.id, i + 1)}
                  >
                    <ArrowDown size={13} />
                  </button>
                </div>
              </div>
            ))}
            {!roles.length && (
              <p className="wb-muted">
                还没有角色，添加两个角色以建立第一条交接。
              </p>
            )}
          </div>
          <div className="wb-actions wb-add-roles">
            <button
              type="button"
              className="wb-btn"
              onClick={() => add("agent")}
            >
              <Plus size={14} />
              Agent 角色
            </button>
            <button
              type="button"
              className="wb-btn"
              onClick={() => add("human")}
            >
              <Plus size={14} />
              真人角色
            </button>
          </div>
        </div>
        <div className="wb-panel wb-role-fields">
          <div className="wb-section-title">
            <h2>角色配置</h2>
            {active && (
              <span className="wb-badge">
                {active.kind === "human" ? "真人角色" : "Agent 角色"}
              </span>
            )}
          </div>
          {active ? (
            <div className="wb-form">
              <div className="wb-form-row">
                <Labeled title="角色名称">
                  <input
                    value={active.name}
                    maxLength={64}
                    onChange={(e) => patch({ name: e.target.value })}
                    placeholder="例如：需求整理"
                  />
                </Labeled>
                <Labeled title="负责成员">
                  <select
                    value={active.assigneeId}
                    onChange={(e) => patch({ assigneeId: e.target.value })}
                  >
                    <option value="">选择成员</option>
                    {tagged
                      .filter(
                        (m) => active.kind !== "agent" || m.role === "owner",
                      )
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                  </select>
                </Labeled>
              </div>
              <Labeled title="职责">
                <textarea
                  rows={2}
                  value={active.duty}
                  onChange={(e) => patch({ duty: e.target.value })}
                  placeholder="写明分工、输入和交付边界"
                />
              </Labeled>
              <div className="wb-role-rule">
                {active.kind === "agent" ? (
                  <label className="wb-switch">
                    <input
                      type="checkbox"
                      checked={active.autoStartOnHandoff === true}
                      onChange={(e) =>
                        patch({ autoStartOnHandoff: e.target.checked })
                      }
                    />
                    <span>
                      <strong>收到上游产物后自动启动</strong>
                      <small>
                        显式提交后，此角色使用自己的执行器与会话继续处理。
                      </small>
                    </span>
                  </label>
                ) : (
                  <Labeled title="评审方式">
                    <select
                      value={active.reviewMode || "standard"}
                      onChange={(e) => patch({ reviewMode: e.target.value })}
                    >
                      <option value="standard">普通签收</option>
                      <option value="design">
                        设计评审 · 负责人编辑并确认开工
                      </option>
                    </select>
                  </Labeled>
                )}
                {active.reviewMode === "design" && (
                  <p className="wb-muted">
                    需要紧邻的上游
                    Agent。确认开工将批准的方案版本交回该角色实施。
                  </p>
                )}
              </div>
              {active.kind === "agent" && (
                <>
                  <div className="wb-section-title wb-bind-title">
                    <h3>本机执行器</h3>
                    <button
                      className="wb-link"
                      type="button"
                      onClick={() => loadCatalog(active.cwd)}
                    >
                      重新检测
                    </button>
                  </div>
                  <div className="wb-form-row">
                    <Labeled title="执行环境">
                      <input readOnly value={env?.name || "当前本机"} />
                    </Labeled>
                    <Labeled title="执行器">
                      <select
                        value={pr ? active.provider : ""}
                        onChange={(e) => {
                          const p = readyProviders.find(
                            (v) => v.id === e.target.value,
                          );
                          patch({
                            provider: e.target.value,
                            model:
                              p?.models?.find((m) => m.isDefault)?.id || "",
                          });
                        }}
                      >
                        <option value="">选择本机发现的执行器</option>
                        {providers.map((p) => (
                          <option
                            disabled={p.available === false}
                            key={p.id}
                            value={p.id}
                          >
                            {p.label || p.id} · {p.status}
                          </option>
                        ))}
                      </select>
                    </Labeled>
                  </div>
                  {(!catalog?.online ||
                    !readyProviders.length ||
                    (active.provider && !pr)) && (
                    <p className="wb-muted">
                      {catalog?.error ||
                        (!catalog
                          ? "输入工作目录后检测可用执行器。"
                          : active.provider && !pr
                            ? `绑定的 ${active.provider} 当前未被发现。`
                            : "当前目录没有可用执行器。")}
                    </p>
                  )}
                  <div className="wb-form-row">
                    <Labeled title="模型">
                      <select
                        value={
                          pr?.models?.some((m) => m.id === active.model)
                            ? active.model
                            : ""
                        }
                        onChange={(e) => patch({ model: e.target.value })}
                      >
                        <option value="">执行器默认模型</option>
                        {(pr?.models || []).map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label || m.id}
                          </option>
                        ))}
                      </select>
                    </Labeled>
                    <Labeled title="工作目录">
                      <input
                        value={active.cwd}
                        onChange={(e) =>
                          patch({
                            cwd: e.target.value,
                            provider: "",
                            model: "",
                          })
                        }
                        onBlur={(e) => {
                          const cwd = e.target.value.trim();
                          if (!cwd) return;
                          if (!catalogs[cwd]) loadCatalog(cwd);
                          else if (!team && template !== "blank")
                            setRoles((current) =>
                              suggestTemplateBindings(current, catalogs[cwd]),
                            );
                        }}
                        placeholder={
                          env?.root || env?.cwd || "执行主机上的绝对路径"
                        }
                      />
                    </Labeled>
                  </div>
                  <div className="wb-form-row">
                    <Labeled title="Skills">
                      <input
                        value={active.skills}
                        onChange={(e) => patch({ skills: e.target.value })}
                        placeholder="多项用逗号分隔"
                      />
                    </Labeled>
                    <Labeled title="业务 CLI">
                      <input
                        value={active.clis}
                        onChange={(e) => patch({ clis: e.target.value })}
                        placeholder="多项用逗号分隔"
                      />
                    </Labeled>
                  </div>
                </>
              )}
              <div className="wb-form-row">
                <Labeled title="交付产物">
                  <input
                    value={active.output}
                    onChange={(e) => patch({ output: e.target.value })}
                    placeholder="例如：需求说明"
                  />
                </Labeled>
                <Labeled title="产物必填字段">
                  <input
                    value={active.requiredFields}
                    onChange={(e) => patch({ requiredFields: e.target.value })}
                    placeholder="多项用逗号分隔"
                  />
                </Labeled>
              </div>
              {active.kind === "agent" && (
                <div className="wb-delivery-policy">
                  <Labeled title="候选与发布职责">
                    <select
                      value={active.delivery?.kind || ""}
                      onChange={(e) => changeDelivery(e.target.value)}
                    >
                      <option value="">普通 Agent</option>
                      <option value="qa">QA · 冻结候选并执行测试</option>
                      <option value="release">
                        SRE · 部署到测试环境并验证
                      </option>
                    </select>
                  </Labeled>
                  {active.delivery?.kind === "qa" && (
                    <>
                      <Labeled title="候选文件（每行一个相对路径）">
                        <textarea
                          rows={5}
                          value={active.delivery.files}
                          onChange={(e) =>
                            patchDelivery({ files: e.target.value })
                          }
                        />
                      </Labeled>
                      <Labeled title="测试命令（argv）">
                        <textarea
                          rows={2}
                          spellCheck={false}
                          value={active.delivery.test}
                          onChange={(e) =>
                            patchDelivery({ test: e.target.value })
                          }
                        />
                      </Labeled>
                      <Labeled title="最多自动修复次数">
                        <input
                          type="number"
                          min="0"
                          max="20"
                          step="1"
                          value={active.delivery.maxRepairs}
                          onChange={(e) =>
                            patchDelivery({ maxRepairs: e.target.value })
                          }
                        />
                      </Labeled>
                    </>
                  )}
                  {active.delivery?.kind === "release" && (
                    <>
                      <Labeled title="目标测试环境">
                        <input
                          value={active.delivery.target}
                          onChange={(e) =>
                            patchDelivery({ target: e.target.value })
                          }
                          placeholder="例如：orders-test"
                        />
                      </Labeled>
                      <Labeled title="部署命令（argv）">
                        <textarea
                          rows={2}
                          spellCheck={false}
                          value={active.delivery.deploy}
                          onChange={(e) =>
                            patchDelivery({ deploy: e.target.value })
                          }
                        />
                      </Labeled>
                      <Labeled title="部署后验证命令（argv）">
                        <textarea
                          rows={2}
                          spellCheck={false}
                          value={active.delivery.verify}
                          onChange={(e) =>
                            patchDelivery({ verify: e.target.value })
                          }
                        />
                      </Labeled>
                    </>
                  )}
                  {active.delivery && (
                    <p className="wb-muted">
                      命令以 JSON
                      字符串数组保存。第一个元素为程序，其余元素分别作为参数传入。
                    </p>
                  )}
                </div>
              )}
              <div className="wb-actions wb-remove">
                {removeId === active.id ? (
                  <>
                    <span>移除该角色？</span>
                    <button
                      type="button"
                      className="wb-btn wb-is-danger"
                      onClick={remove}
                    >
                      移除
                    </button>
                    <button
                      type="button"
                      className="wb-btn"
                      onClick={() => setRemoveId(null)}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="wb-link"
                    onClick={() => setRemoveId(active.id)}
                  >
                    <Trash2 size={14} />
                    移除角色
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="wb-empty wb-compact">
              <Workflow size={24} />
              <p>选择角色以配置职责和产物。</p>
            </div>
          )}
        </div>
      </section>
    </form>
  );
}
