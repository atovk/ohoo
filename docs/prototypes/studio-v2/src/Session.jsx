import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  FileText,
  Folder,
  GitPullRequest,
  Inbox,
  Monitor,
  Paperclip,
  PencilLine,
  Send,
  ShieldCheck,
  Square,
  Terminal,
  UserRound,
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
import "./session.css";

const statusText = {
  ready: "就绪",
  running: "处理中",
  stopping: "正在停止",
  stopped: "已停止",
  manual: "人工接手",
};
const roleById = (r, id) => r.nodes.find((n) => n.id === id);
const nameById = (r, id) => roleById(r, id)?.name || "已移除角色";
const nextEdges = (r, n) =>
  r.edges.filter((e) => e.from === n.id && roleById(r, e.to));
const isActive = (r, n) => r.status !== "已完成" && r.current === n.id;
const generic = (r, n, user) =>
  r.template !== "delivery" && n.owner === user && isActive(r, n);
const fieldKeys = (n) => [
  ...new Set((n.fields || []).map((k) => String(k).trim()).filter(Boolean)),
];
const valueOf = (fields, k) =>
  fields && Object.hasOwn(fields, k) ? String(fields[k] ?? "") : "";
const revision = (r, id) =>
  1 +
  Math.max(
    0,
    ...r.artifacts.filter((a) => a.id === id).map((a) => Number(a.rev) || 1),
  );
function lastOutputs(r, n) {
  const all = new Map();
  r.artifacts.filter((a) => a.nodeId === n.id).forEach((a) => all.set(a.id, a));
  return [...all.values()].reverse();
}
function visible(r, n, user) {
  return r.artifacts
    .filter(
      (a) =>
        (a.nodeId === n.id || a.toId === n.id) &&
        (n.owner === user ||
          roleById(r, a.nodeId)?.owner === user ||
          roleById(r, a.toId)?.owner === user),
    )
    .slice()
    .reverse();
}
function initial(r, n) {
  const example =
    r.template === "delivery" &&
    n.id === "dev" &&
    r.artifacts.some((a) => a.nodeId === "dev");
  return {
    mode: "ready",
    draft: "",
    pending: null,
    staged: null,
    messages: example
      ? [
          {
            id: "brief",
            from: "user",
            text: "订单 CSV 要导出全部筛选结果，遵循读取权限和列表排序。请先起草设计，把跨页情况列入验收。",
          },
          {
            id: "proposal",
            from: "agent",
            text:
              "已提交的方案草稿\n" +
              r.artifacts.filter((a) => a.nodeId === "dev").at(-1).body +
              "\n\n验收样例\n授权范围命中 43 条订单时，导出应有 43 行。",
          },
        ]
      : [],
  };
}
function ownSession(r, n) {
  r.sessions ||= {};
  return (r.sessions[n.id] ||= initial(r, n));
}
function agentReply(n, messages) {
  const input = messages
    .map((m) => m.text)
    .join("\n")
    .trim();
  const linked = /https?:\/\/\S+/i.test(input);
  const text = input.replace(/https?:\/\/\S+/gi, "").trim();
  if (linked && !text)
    return "我收到了这个链接，当前模拟没有读取正文。请贴入相关段落、会议决定或可分享的摘要，我会据此继续。";
  const excerpt = text.length > 160 ? text.slice(0, 160) + "…" : text;
  let next = "我将这条说明作为本轮工作依据。请补充需要交付的格式或验收标准。";
  if (/订单|分页|导出|CSV/i.test(text))
    next =
      "将上述范围写入方案。跨页时核对导出行数与授权范围内的筛选结果，并验证列表排序。";
  else if (/稿件|文章|撰稿|编辑/.test(n.name + text))
    next =
      "按照这条意见修订稿件。请指出需要改写的段落，或者提供需要保留的原句。";
  else if (/会议|决定|纪要|转写|需求/.test(text))
    next =
      "将上面的说明整理为需求输入。明确负责人、交付内容及完成条件后，可提交给下一位。";
  return (
    "本轮依据\n「" +
    excerpt +
    "」\n\n" +
    next +
    (linked ? "\n\n链接正文未读取，仅保留你提供的引用。" : "")
  );
}
function hostContext(ws, n, user) {
  if (n.kind === "human")
    return { device: "本人操作", provider: "真人节点", reason: "" };
  const host = ws.envs.find((e) => e.id === n.envId);
  const binding = host?.providers?.find((p) => p.name === n.provider);
  let reason = "";
  if (!host) reason = "尚未绑定执行环境";
  else if (host.owner !== user) reason = "执行环境属于另一位成员";
  else if (host.kind === "remote" && ws.allowRemote === false)
    reason = "工作区暂停远端执行";
  else if (host.status !== "在线") reason = "执行环境离线";
  else if (!binding) reason = "此环境未发现绑定的执行器";
  else if (binding.status === "需登录") reason = "执行器需要本人登录";
  else if (binding.status !== "已验证") reason = "执行器已发现，等待试跑验证";
  else if (
    n.model &&
    binding.models?.length &&
    !binding.models.includes(n.model)
  )
    reason = "绑定模型尚未在此环境中发现";
  return {
    device: host?.name || "未绑定",
    provider: n.provider || "未绑定",
    reason,
  };
}
function Btn({ children, primary = false, flat = false, ...props }) {
  return (
    <button
      type="button"
      className={"ss-btn" + (primary ? " b" : "") + (flat ? " flat" : "")}
      {...props}
    >
      {children}
    </button>
  );
}
function Facts({ n, context, own }) {
  const cells = own
    ? [
        [UserRound, "执行身份", n.owner],
        [Terminal, "执行器", context.provider],
        [Monitor, "执行主机", context.device],
        [Folder, "工作目录", n.kind === "human" ? "—" : n.cwd || "未设置"],
      ]
    : [
        [UserRound, "执行身份", n.owner],
        [ShieldCheck, "会话状态", "成员私有"],
      ];
  return (
    <dl className="ss-meta">
      {cells.map(([Icon, k, v]) => (
        <div key={k}>
          <dt>
            <Icon size={13} />
            {k}
          </dt>
          <dd className={k === "工作目录" ? "ss-path" : ""}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
function ArtifactProperties({ fields }) {
  const pairs = Object.entries(fields || {});
  return pairs.length ? (
    <dl>
      {pairs.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{String(v)}</dd>
        </div>
      ))}
    </dl>
  ) : null;
}
function ArtifactRead({ r, v, previous }) {
  return (
    <div className="ss-read">
      <p className="ss-route">
        {nameById(r, v.nodeId)} <ArrowRight size={15} /> {nameById(r, v.toId)}
      </p>
      <small className="ss-muted">
        v{v.rev} · {v.status} · {v.actor}
      </small>
      <h3>{v.title}</h3>
      <div className="ss-document">{v.body}</div>
      <ArtifactProperties fields={v.fields} />
      <dl>
        <div>
          <dt>交接摘要</dt>
          <dd>{v.summary}</dd>
        </div>
        {(v.feedback || v.review) && (
          <div>
            <dt>退回意见</dt>
            <dd>{v.feedback || v.review}</dd>
          </div>
        )}
      </dl>
      {previous && (
        <details>
          <summary>对照上一版 v{previous.rev}</summary>
          <div className="ss-document">{previous.body}</div>
          <ArtifactProperties fields={previous.fields} />
          {(previous.feedback || previous.review) && (
            <p>上轮意见 · {previous.feedback || previous.review}</p>
          )}
        </details>
      )}
    </div>
  );
}
function Handoff({ r, n, seedBody = "", onClose, onCommit }) {
  const outputs = lastOutputs(r, n);
  const first = outputs.find((a) => a.status === "已退回") || outputs[0];
  const edges = nextEdges(r, n);
  const [editor, setEditor] = useState(() => ({
    id: first?.id || "",
    title: first?.title || n.output || "工作产物",
    body: seedBody || first?.body || "",
    fields: { ...(first?.fields || {}) },
    summary: "",
    edgeId: edges[0]?.id || "",
  }));
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState("");
  const [generatedId] = useState(() => uid());
  const edge = edges.find((e) => e.id === editor.edgeId);
  const keys = fieldKeys(n);
  const id = editor.id || generatedId;
  const rev = revision(r, id);
  const previous = outputs.find((o) => o.id === editor.id);
  const update = (k, v) => setEditor((d) => ({ ...d, [k]: v }));
  const startPreview = (e) => {
    e.preventDefault();
    const missing = keys.find((k) => !valueOf(editor.fields, k).trim());
    if (missing) {
      setError("请填写「" + missing + "」");
      return;
    }
    if (
      !editor.title.trim() ||
      !editor.body.trim() ||
      !editor.summary.trim() ||
      !edge
    ) {
      setError("请补全名称、正文、摘要与接收角色。");
      return;
    }
    setError("");
    setPreview(true);
  };
  const data = {
    id,
    title: editor.title.trim(),
    body: editor.body.trim(),
    fields: Object.fromEntries(
      keys.map((k) => [k, valueOf(editor.fields, k).trim()]),
    ),
    summary: editor.summary.trim(),
    edgeId: edge?.id,
    toId: edge?.to,
  };
  return (
    <Modal title={preview ? "交接预览" : "准备交接"} onClose={onClose}>
      {preview ? (
        <div className="ss-read">
          <ArtifactRead
            r={r}
            v={{ ...data, rev, nodeId: n.id, status: "待提交", actor: n.owner }}
          />
          <div className="ss-summary">
            接收者只得到以上产物和摘要。私有对话、执行日志及凭据留在本人的会话。
          </div>
          <div className="ss-form-foot">
            <Btn onClick={() => setPreview(false)}>返回修改</Btn>
            <Btn primary onClick={() => onCommit(data, edge.mode)}>
              {edge.mode === "auto" ? "提交并自动转交" : "保存待手动转交"}{" "}
              <ArrowRight />
            </Btn>
          </div>
        </div>
      ) : (
        <form className="ss-form" onSubmit={startPreview}>
          {outputs.length > 0 && (
            <Field label="修订对象">
              <select
                value={editor.id}
                onChange={(e) => {
                  const prior = outputs.find((o) => o.id === e.target.value);
                  setEditor((d) => ({
                    ...d,
                    id: prior?.id || "",
                    title: prior?.title || n.output || "工作产物",
                    body: prior?.body || "",
                    fields: { ...prior?.fields },
                  }));
                }}
              >
                <option value="">新产物</option>
                {outputs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.title} · v{o.rev}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {(previous?.feedback || previous?.review) && (
            <p className="ss-summary">
              上轮意见 · {previous.feedback || previous.review}
            </p>
          )}
          <Field label="产物名称">
            <input
              required
              value={editor.title}
              onChange={(e) => update("title", e.target.value)}
              maxLength={120}
            />
          </Field>
          <Field label="提交的正文或文件引用">
            <textarea
              required
              rows="4"
              value={editor.body}
              onChange={(e) => update("body", e.target.value)}
            />
          </Field>
          {keys.map((k) => (
            <Field key={k} label={k}>
              <textarea
                required
                rows="2"
                value={valueOf(editor.fields, k)}
                onChange={(e) =>
                  update("fields", { ...editor.fields, [k]: e.target.value })
                }
              />
            </Field>
          ))}
          <Field label="交接摘要">
            <textarea
              required
              rows="2"
              value={editor.summary}
              onChange={(e) => update("summary", e.target.value)}
              placeholder="下一位需要知道什么？"
            />
          </Field>
          <Field label="接收角色与交接规则">
            <select
              value={editor.edgeId}
              onChange={(e) => update("edgeId", e.target.value)}
            >
              {edges.map((e) => (
                <option value={e.id} key={e.id}>
                  {nameById(r, e.to)} · {e.label} ·{" "}
                  {e.mode === "auto" ? "自动" : "手动"}
                </option>
              ))}
            </select>
          </Field>
          {error && <p className="ss-error">{error}</p>}
          <div className="ss-form-foot">
            <button type="submit" className="ss-btn b">
              预览交接 <ArrowRight size={15} />
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
function Review({ r, n, user, v, onClose, onDecision }) {
  const [feedback, setFeedback] = useState("");
  const older = r.artifacts
    .filter((a) => a.id === v.id && a.rev < v.rev)
    .sort((a, b) => b.rev - a.rev)[0];
  const permitted =
    generic(r, n, user) && v.toId === n.id && v.status === "待签收";
  const ending =
    permitted &&
    !nextEdges(r, n).length &&
    !r.artifacts.some((a) => a !== v && a.status === "待签收");
  return (
    <Modal title={v.title} onClose={onClose}>
      <ArtifactRead r={r} v={v} previous={older} />
      {permitted && (
        <div className="ss-read">
          {ending && <p className="ss-summary">团队完成条件 · {r.finish}</p>}
          <label>
            退回意见
            <textarea
              value={feedback}
              rows="2"
              placeholder="请说明需要修改的地方"
              onChange={(e) => setFeedback(e.target.value)}
            />
          </label>
          <div className="ss-review-actions">
            <Btn
              disabled={!feedback.trim()}
              onClick={() => onDecision("return", feedback.trim())}
            >
              退回修订
            </Btn>
            <Btn primary onClick={() => onDecision("accept", "")}>
              <Check />
              {ending ? "确认条件已满足，签收并归档" : "签收此版本"}
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}
function Thread({
  n,
  s,
  context,
  closed,
  user,
  onSend,
  onDraft,
  onTake,
  onStop,
  onHandback,
  onUse,
}) {
  const human = n.kind === "human",
    manual = human || s.mode === "manual";
  const canSend =
    !closed && (manual || (!context.reason && s.mode !== "stopping"));
  const tape = useRef(null),
    file = useRef(null);
  useEffect(() => {
    if (tape.current) tape.current.scrollTop = tape.current.scrollHeight;
  }, [s.messages.length, s.mode]);
  const attach = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const textual =
      /^text\//.test(f.type) ||
      /\.(md|txt|log|json|csv|yaml|yml)$/i.test(f.name);
    let contents = "仅记录文件名，未读取正文。";
    if (textual) {
      try {
        contents =
          (await f.slice(0, 24000).text()) +
          (f.size > 24000 ? "\n（仅摘录前 24 KB）" : "");
      } catch {
        contents = "未能读取正文，可粘贴摘录。";
      }
    }
    onDraft("文件：" + f.name + "\n" + contents, true);
    if (file.current) file.current.value = "";
  };
  return (
    <section className="ss-thread">
      <header className="ss-thread-head">
        <div>
          <Terminal size={16} />
          <h2>{human ? "工作笔记" : "会话终端"}</h2>
        </div>
        <small>本地模拟 · 外链正文未读取</small>
      </header>
      <div className="ss-tape" ref={tape} aria-live="polite">
        {s.messages.length ? (
          s.messages.map((m) => (
            <article
              key={m.id}
              className={
                "ss-entry " + (m.from === "agent" ? "agent" : "person")
              }
            >
              <span className="ss-symbol">
                {m.from === "agent" ? (
                  <Terminal size={15} />
                ) : (
                  <UserRound size={14} />
                )}
              </span>
              <div>
                <div className="ss-author">
                  {m.from === "agent" ? n.name : user}
                  <small>
                    {m.from === "agent"
                      ? "模拟回复"
                      : manual
                        ? "成员笔记"
                        : "成员输入"}
                  </small>
                </div>
                <div className="ss-body">{m.text}</div>
                {m.from === "agent" && onUse && (
                  <button
                    type="button"
                    className="ss-textlink"
                    onClick={() => onUse(m.text)}
                  >
                    <FileText size={12} />
                    作为产物
                  </button>
                )}
              </div>
            </article>
          ))
        ) : (
          <p className="ss-empty">
            {human
              ? "可在此记录自己的判断，并审阅收到的产物。"
              : "为这次工作补充具体任务、材料或验收条件。"}
          </p>
        )}
        {s.mode === "running" && (
          <div className="ss-tool">
            <Terminal size={14} />
            正在整理本轮材料…
          </div>
        )}
        {s.mode === "stopping" && (
          <div className="ss-tool">
            <Square size={13} />
            正在确认当前模拟执行已停止…
          </div>
        )}
      </div>
      <form
        className="ss-composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend && s.draft?.trim()) onSend();
        }}
      >
        <header>
          <span>{human ? "人工处理" : statusText[s.mode]}</span>
          <span>{context.reason || "仅本人可见"}</span>
        </header>
        <textarea
          value={s.draft || ""}
          onChange={(e) => onDraft(e.target.value)}
          aria-label="角色会话输入"
          disabled={!canSend}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (canSend && s.draft?.trim()) onSend();
            }
          }}
          placeholder={manual ? "写下修改或判断…" : "输入任务、链接或会议摘录…"}
        />
        <div className="ss-actions">
          <div>
            <input type="file" ref={file} onChange={attach} hidden />
            <Btn
              flat
              disabled={!canSend}
              onClick={() => file.current?.click()}
              title="添加已有文件"
            >
              <Paperclip />
              文件
            </Btn>
            {!human && !closed && s.mode === "running" && (
              <Btn flat onClick={onStop}>
                <Square />
                停止
              </Btn>
            )}
            {!human &&
              !closed &&
              s.mode !== "manual" &&
              s.mode !== "stopping" && (
                <Btn flat onClick={onTake}>
                  <PencilLine />
                  人工接手
                </Btn>
              )}
            {!human && !closed && s.mode === "manual" && (
              <Btn flat disabled={!!context.reason} onClick={onHandback}>
                交还 agent
              </Btn>
            )}
          </div>
          <button
            type="submit"
            className="ss-btn b"
            disabled={!canSend || !s.draft?.trim()}
          >
            <Send />
            {manual ? "记录" : "发送"}
          </button>
        </div>
      </form>
    </section>
  );
}
function SessionView({ ctx, n }) {
  const { ws, team, run: r, user, nav, updateRun, toast } = ctx;
  const mine = n.owner === user,
    delivery = r.template === "delivery",
    closed = r.status === "已完成";
  const base = mine ? r.sessions?.[n.id] || initial(r, n) : null;
  const context = hostContext(ws, n, user),
    items = visible(r, n, user),
    edges = nextEdges(r, n);
  const incoming = r.artifacts.some(
    (a) => a.toId === n.id && a.status === "待签收",
  );
  const maySubmit =
    mine &&
    !delivery &&
    isActive(r, n) &&
    edges.length > 0 &&
    !incoming &&
    !base?.staged &&
    !["running", "stopping"].includes(base?.mode);
  const [dialog, setDialog] = useState(null);
  const [handback, setHandback] = useState("");
  const close = () => setDialog(null);
  const mutate = (fn) => updateRun(fn, team.id, r.id);
  const act = (fn) =>
    mutate((next) => {
      const role = roleById(next, n.id);
      if (!role || role.owner !== user || next.status === "已完成") return;
      fn(next, role, ownSession(next, role));
    });
  const showRun = () =>
    nav("run", { teamId: team.id, runId: r.id, nodeId: n.id, tab: "action" });

  // Persist the pending ticket. On re-entry, resolve the same local turn once.
  const pending = base?.pending;
  useEffect(() => {
    if (!mine || !pending) return;
    const timer = setTimeout(
      () => {
        updateRun(
          (next) => {
            const role = roleById(next, n.id),
              s = next.sessions?.[n.id];
            if (
              !s ||
              !role ||
              role.owner !== user ||
              s.pending?.id !== pending.id
            )
              return;
            if (next.status === "已完成") {
              s.mode = "stopped";
              s.pending = null;
              return;
            }
            if (s.mode === "stopping") {
              const take = s.pending.take === true;
              s.mode = take ? "manual" : "stopped";
              if (take) s.takeStart = s.messages.length;
              addEvent(
                next,
                n.id,
                take ? "原回合已停止，成员接手" : "当前模拟回合已停止",
                user,
              );
            } else if (s.mode === "running") {
              s.messages.push({
                id: uid(),
                from: "agent",
                text: agentReply(
                  role,
                  s.messages
                    .slice(s.pending.start)
                    .filter((m) => m.from === "user"),
                ),
              });
              s.mode = "ready";
            }
            s.pending = null;
          },
          team.id,
          r.id,
        );
      },
      Math.max(10, pending.due - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [mine, pending?.id, team.id, r.id, n.id, user]);

  function queue(s, text) {
    s.messages.push({ id: uid(), from: "user", text });
    s.pending = {
      id: uid(),
      due: Date.now() + 1000,
      start: s.pending?.start ?? s.messages.length - 1,
    };
    s.mode = "running";
  }
  function onSend() {
    act((next, role, s) => {
      const text = s.draft.trim();
      if (!text || s.mode === "stopping") return;
      if (role.kind === "human" || s.mode === "manual")
        s.messages.push({ id: uid(), from: "user", text });
      else {
        if (hostContext(ws, role, user).reason) return;
        queue(s, text);
      }
      s.draft = "";
    });
  }
  function requestStop(take) {
    act((next, role, s) => {
      if (role.kind === "human") return;
      if (s.mode === "running") {
        s.mode = "stopping";
        s.pending = { id: uid(), due: Date.now() + 400, take };
        return;
      }
      if (take && s.mode !== "stopping") {
        s.mode = "manual";
        s.pending = null;
        s.takeStart = s.messages.length;
        addEvent(next, n.id, "成员已接手，agent 暂停写入", user);
      }
    });
  }
  function openHandback() {
    const last = base.messages
      .slice(base.takeStart ?? base.messages.length)
      .filter((m) => m.from === "user")
      .at(-1);
    setHandback(last?.text || "");
    setDialog({ type: "handback" });
  }
  function resume() {
    const text = handback.trim();
    if (!text) return;
    act((next, role, s) => {
      if (s.mode !== "manual" || hostContext(ws, role, user).reason) return;
      s.pending = null;
      queue(s, "交还说明：" + text);
      addEvent(next, n.id, "成员交还执行，agent 按修订继续", user);
    });
    close();
  }
  function transfer(next, role, s, draft, manual) {
    if (
      !generic(next, role, user) ||
      next.artifacts.some((x) => x.toId === role.id && x.status === "待签收")
    )
      return;
    const edge = nextEdges(next, role).find(
      (e) => e.id === draft.edgeId && e.to === draft.toId,
    );
    if (!edge || fieldKeys(role).some((k) => !valueOf(draft.fields, k).trim()))
      return;
    if (manual && s.staged?.id !== draft.id) return;
    const rev = revision(next, draft.id);
    next.artifacts.push({
      id: draft.id,
      rev,
      nodeId: role.id,
      toId: edge.to,
      title: draft.title,
      body: draft.body,
      summary: draft.summary,
      fields: { ...draft.fields },
      status: "待签收",
      actor: user,
    });
    s.staged = null;
    advance(
      next,
      edge.to,
      role.name +
        " → " +
        nameById(next, edge.to) +
        " · " +
        (manual ? "手动" : "自动") +
        "转交《" +
        draft.title +
        "》v" +
        rev,
      user,
    );
  }
  function submit(draft, mode) {
    if (!maySubmit) return;
    act((next, role, s) => {
      if (
        !generic(next, role, user) ||
        s.staged ||
        next.artifacts.some((a) => a.toId === role.id && a.status === "待签收")
      )
        return;
      if (mode === "auto") transfer(next, role, s, draft, false);
      else {
        s.staged = clone(draft);
        addEvent(
          next,
          role.id,
          "保存待交稿《" + draft.title + "》，等待成员手动转交",
          user,
        );
      }
    });
    close();
    toast(mode === "auto" ? "产物已自动转交" : "已保存待交稿，可手动转交");
  }
  function decide(v, decision, feedback) {
    act((next, role) => {
      if (!generic(next, role, user)) return;
      const item = next.artifacts.find(
        (a) => a.id === v.id && a.rev === v.rev && a.toId === role.id,
      );
      if (!item || item.status !== "待签收") return;
      if (decision === "return") {
        item.status = "已退回";
        item.feedback = feedback;
        item.review = feedback;
        advance(
          next,
          item.nodeId,
          role.name +
            "退回《" +
            item.title +
            "》v" +
            item.rev +
            " · " +
            feedback,
          user,
        );
      } else {
        item.status = "已签收";
        item.signedBy = user;
        addEvent(next, role.id, "签收《" + item.title + "》v" + item.rev, user);
        if (
          !nextEdges(next, role).length &&
          !next.artifacts.some((a) => a.status === "待签收")
        ) {
          next.status = "已完成";
          addEvent(next, role.id, "负责人确认团队结束条件，归档本次运行", user);
        }
      }
    });
    close();
  }
  const shown =
    dialog?.type === "artifact"
      ? items.find((v) => v.id === dialog.id && v.rev === dialog.rev)
      : null;
  const active = isActive(r, n),
    status = closed ? "已归档" : active ? "当前经办" : "查看记录";
  return (
    <main className="ss-view">
      <header className="ss-top">
        <div>
          <button
            type="button"
            className="ss-back"
            onClick={() =>
              ctx.route.tab?.startsWith("from-run")
                ? nav("run", {
                    teamId: team.id,
                    runId: r.id,
                    nodeId: n.id,
                    tab: ctx.route.tab === "from-run-map" ? "map" : "action",
                  })
                : nav("canvas", { teamId: team.id, runId: r.id, nodeId: n.id })
            }
          >
            <ArrowLeft size={14} />
            {ctx.route.tab?.startsWith("from-run") ? "返回运行" : "团队画布"}
          </button>
          <div className="ss-heading">
            <h1>{n.name}</h1>
            <Badge tone={active ? "green" : "neutral"}>{status}</Badge>
          </div>
          <p className="ss-subtitle">
            <code>{r.id}</code> / {r.title} · 流程 v{r.version}
          </p>
        </div>
        {delivery ? (
          <Button onClick={showRun}>
            <GitPullRequest size={16} />
            运行操作 <ArrowUpRight size={14} />
          </Button>
        ) : mine && active && !incoming && !edges.length ? (
          <Button variant="primary" onClick={showRun}>
            <Send size={15} />
            提交最终产物
          </Button>
        ) : (
          mine &&
          edges.length > 0 && (
            <Button
              variant="primary"
              disabled={!maySubmit}
              onClick={() => setDialog({ type: "handoff", body: "" })}
            >
              <Send size={15} />
              {incoming ? "先签收来件" : "提交产物"}
            </Button>
          )
        )}
      </header>
      <Facts n={n} context={context} own={mine} />
      <div className="ss-layout">
        {mine ? (
          <Thread
            n={n}
            s={base}
            context={context}
            closed={closed}
            user={user}
            onDraft={(text, append = false) =>
              act((next, role, s) => {
                s.draft = append
                  ? [s.draft, text].filter(Boolean).join("\n")
                  : text;
              })
            }
            onSend={onSend}
            onStop={() => requestStop(false)}
            onTake={() => requestStop(true)}
            onHandback={openHandback}
            onUse={
              maySubmit
                ? (text) => setDialog({ type: "handoff", body: text })
                : null
            }
          />
        ) : (
          <section className="ss-thread ss-private">
            <ShieldCheck size={22} />
            <h2>成员私有会话</h2>
            <p>此角色由{n.owner}操作。你可以查看与你有关的已提交产物。</p>
          </section>
        )}
        <aside className="ss-rail">
          <section>
            <h2>
              本次交接 <span className="ss-count">{items.length}</span>
            </h2>
            {mine && base?.staged && (
              <div className="ss-staged">
                <small>待手动转交</small>
                <strong>{base.staged.title}</strong>
                <small>接收角色 · {nameById(r, base.staged.toId)}</small>
                <div className="ss-actions">
                  <Btn
                    primary
                    disabled={!active || delivery}
                    onClick={() => {
                      act((next, role, s) => {
                        if (s.staged) transfer(next, role, s, s.staged, true);
                      });
                      toast("已手动转交");
                    }}
                  >
                    手动转交 <ArrowRight />
                  </Btn>
                  <Btn
                    flat
                    disabled={!active || delivery}
                    onClick={() =>
                      act((next, role, s) => {
                        s.staged = null;
                      })
                    }
                  >
                    撤回待交稿
                  </Btn>
                </div>
              </div>
            )}
            {items.length ? (
              items.map((v) => (
                <button
                  type="button"
                  key={v.id + ":" + v.rev}
                  className="ss-record"
                  onClick={() =>
                    setDialog({ type: "artifact", id: v.id, rev: v.rev })
                  }
                >
                  <small>
                    {v.toId === n.id
                      ? "收到 · " + nameById(r, v.nodeId)
                      : "发出 · " + nameById(r, v.toId)}
                  </small>
                  <strong>
                    {v.title} <em>v{v.rev}</em>
                  </strong>
                  <span className="ss-state">{v.status}</span>
                </button>
              ))
            ) : (
              <p>尚无已转交的产物。</p>
            )}
          </section>
          {mine && context.reason && (
            <section>
              <h2>执行环境</h2>
              <p>{context.reason}</p>
              <button
                type="button"
                className="ss-textlink"
                onClick={() => nav("env")}
              >
                查看执行环境 <ChevronRight size={13} />
              </button>
            </section>
          )}
          {mine && (
            <section>
              <h2>
                角色配置 <FileText size={15} />
              </h2>
              <dl>
                <dt>职责</dt>
                <dd>{n.duty || "未填写"}</dd>
                <dt>交付物</dt>
                <dd>{n.output || "由团队定义"}</dd>
                {n.fields?.length > 0 && (
                  <>
                    <dt>产物字段</dt>
                    <dd>{n.fields.join("、")}</dd>
                  </>
                )}
                {[...(n.skills || []), ...(n.clis || [])].length > 0 && (
                  <>
                    <dt>Skills / CLI</dt>
                    <dd>
                      {[...(n.skills || []), ...(n.clis || [])].join(" · ")}
                    </dd>
                  </>
                )}
              </dl>
            </section>
          )}
          {delivery && (
            <section>
              <h2>
                研发工作项 <GitPullRequest size={15} />
              </h2>
              <p>设计确认、QA 复验和生产放行在本次运行中按阶段处理。</p>
              <button type="button" className="ss-textlink" onClick={showRun}>
                查看当前操作 <ChevronRight size={13} />
              </button>
            </section>
          )}
        </aside>
      </div>
      {dialog?.type === "handoff" && maySubmit && (
        <Handoff
          r={r}
          n={n}
          seedBody={dialog.body}
          onClose={close}
          onCommit={submit}
        />
      )}
      {shown && (
        <Review
          r={r}
          n={n}
          user={user}
          v={shown}
          onClose={close}
          onDecision={(d, f) => decide(shown, d, f)}
        />
      )}
      {dialog?.type === "handback" && mine && base.mode === "manual" && (
        <Modal title="交还给角色 agent" onClose={close}>
          <form
            className="ss-form"
            onSubmit={(e) => {
              e.preventDefault();
              resume();
            }}
          >
            <Field label="修改说明与下一步">
              <textarea
                required
                rows="4"
                value={handback}
                onChange={(e) => setHandback(e.target.value)}
                placeholder="写明已改内容、依据版本和下一步"
              />
            </Field>
            <div className="ss-form-foot">
              <button
                className="ss-btn b"
                type="submit"
                disabled={!handback.trim()}
              >
                交还并继续 <ArrowRight size={15} />
              </button>
            </div>
          </form>
        </Modal>
      )}
    </main>
  );
}
export function Session() {
  const ctx = useStudio();
  const n =
    ctx.team?.members.includes(ctx.user) &&
    ctx.run &&
    roleById(ctx.run, ctx.route.nodeId || ctx.run.current);
  if (!n)
    return (
      <section className="ss-private">
        <Inbox size={23} />
        <h2>没有可操作的角色</h2>
        <p>请从团队画布打开一次运行中的角色节点。</p>
        <Button onClick={() => ctx.nav("canvas")}>返回画布</Button>
      </section>
    );
  return (
    <SessionView
      key={[ctx.ws.id, ctx.team.id, ctx.run.id, n.id, ctx.user].join("/")}
      ctx={ctx}
      n={n}
    />
  );
}
