import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Folder,
  Monitor,
  Paperclip,
  RefreshCw,
  Send,
  ShieldCheck,
  Terminal,
  UserRound,
  X,
} from "lucide-react";
import { api, requestId } from "./api";
import "./session.css";

const encoded = (value) => encodeURIComponent(value);
const turnText = {
  pending: "等待执行",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
};
const artifactText = {
  pending: "待签收",
  accepted: "已签收",
  returned: "已退回",
  superseded: "已被新版替代",
};
const hasPending = (session) =>
  session?.turns?.some(
    (turn) => turn.status === "pending" || turn.status === "running",
  );
const feedbackOf = (artifact) => artifact.feedback || "";
const newest = (list) => [...list].sort((a, b) => b.revision - a.revision)[0];
const fieldValue = (values, key) =>
  values && Object.hasOwn(values, key) ? String(values[key] ?? "") : "";
const errorText = (e) =>
  e instanceof Error ? e.message : "请求失败，请重试。";

function Button({ children, primary = false, subtle = false, ...props }) {
  return (
    <button
      type="button"
      className={`rs-button${primary ? " primary" : ""}${subtle ? " subtle" : ""}`}
      {...props}
    >
      {children}
    </button>
  );
}
function Dialog({ title, onClose, busy = false, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="rs-dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !busy) {
          const box = ref.current.getBoundingClientRect();
          if (
            e.clientX < box.left ||
            e.clientX > box.right ||
            e.clientY < box.top ||
            e.clientY > box.bottom
          )
            onClose();
        }
      }}
    >
      <header className="rs-dialog-head">
        <h2>{title}</h2>
        <Button subtle onClick={onClose} disabled={busy} aria-label="关闭">
          <X />
        </Button>
      </header>
      <div className="rs-dialog-body">{children}</div>
    </dialog>
  );
}

// Poll the private session separately from the shareable run. Unmounts invalidate in-flight reads.
const openings = new Map();
function openSessionOnce(path, userId) {
  const key = userId + "|" + path;
  if (!openings.has(key)) {
    const opening = api(path + "/open", { method: "POST", body: {} }).finally(
      () => openings.delete(key),
    );
    openings.set(key, opening);
  }
  return openings.get(key);
}
function useSession(path, userId, enabled, current, autoWorking) {
  const [session, setSession] = useState(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [opening, setOpening] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const opened = useRef(false);
  const reload = useCallback(() => setEpoch((v) => v + 1), []);
  useEffect(() => {
    if (!enabled) {
      setSession(null);
      setError("");
      setReady(false);
      return;
    }
    let alive = true,
      timer,
      openError = "";
    const controller = new AbortController();
    async function read() {
      try {
        const result = await api(path, { signal: controller.signal });
        if (!alive) return;
        setSession(result);
        setError(openError);
        setReady(!openError && (!current || opened.current));
        timer = setTimeout(
          read,
          hasPending(result) || autoWorking ? 900 : 5000,
        );
      } catch (e) {
        if (!alive) return;
        const forbidden = e.status === 401 || e.status === 403;
        if (forbidden) setSession(null);
        setReady(false);
        setError(openError || errorText(e));
        if (!forbidden) timer = setTimeout(read, 4500);
      }
    }
    async function start() {
      if (current && !opened.current) {
        setOpening(true);
        setReady(false);
        try {
          await openSessionOnce(path, userId);
          if (alive) opened.current = true;
        } catch (e) {
          openError = errorText(e);
        } finally {
          if (alive) setOpening(false);
        }
      }
      if (alive) read();
    }
    start();
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [path, userId, enabled, current, autoWorking, epoch]);
  return { session, error, ready, opening, reload };
}

// Retrying an unacknowledged POST with unchanged data reuses its idempotency key.
function useCommand() {
  const previous = useRef(null),
    locked = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function send(path, payload) {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true);
    setError("");
    const fingerprint = JSON.stringify([path, payload]);
    if (previous.current?.fingerprint !== fingerprint)
      previous.current = { fingerprint, id: requestId() };
    try {
      const id = previous.current.id;
      const result = await api(path, {
        method: "POST",
        body: { ...payload, requestId: id },
      });
      previous.current = null;
      return { requestId: id, result };
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return { send, busy, error };
}
function Properties({ values }) {
  const entries = Object.entries(values || {});
  return (
    entries.length > 0 && (
      <dl>
        {entries.map(([key, v]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{String(v)}</dd>
          </div>
        ))}
      </dl>
    )
  );
}
function RoleFacts({ role, user, environment }) {
  const mine = role.assigneeId === user.id;
  const facts = [
    [
      UserRound,
      "执行身份",
      mine ? user.name : role.assigneeName || role.assigneeId || "未分配",
    ],
  ];
  if (mine)
    facts.push(
      [
        Terminal,
        "执行器",
        role.kind === "human" ? "真人节点" : role.provider || "未绑定",
      ],
      [
        Monitor,
        "执行环境",
        role.kind === "human"
          ? "人工处理"
          : environment || role.environmentId || "未绑定",
      ],
      [Folder, "工作目录", role.kind === "human" ? "—" : role.cwd || "未设置"],
    );
  return (
    <dl className="rs-meta">
      {facts.map(([Icon, title, value]) => (
        <div key={title}>
          <dt>
            <Icon size={13} />
            {title}
          </dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
const isDeliveryGate = (role) =>
  ["qa", "release"].includes(role?.delivery?.kind);
const opLabels = { test: "QA 测试", deploy: "部署", verify: "部署后验证" };
const outcomeLabels = {
  running: "命令执行中",
  succeeded: "命令通过",
  failed: "命令失败",
  unknown: "结果待核对",
};

function Snapshot({ candidate }) {
  if (!candidate) return null;
  return (
    <div className="rs-snapshot">
      <dl>
        <dt>候选摘要</dt>
        <dd>
          <code>{candidate.digest}</code>
        </dd>
      </dl>
      {candidate.files?.length > 0 && (
        <details>
          <summary>快照文件（{candidate.files.length}）</summary>
          <ul>
            {candidate.files.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
function CandidateNotice({ role, recipient }) {
  if (recipient.delivery?.kind !== "qa") return null;
  const qa = recipient.delivery;
  const canRepair = role.autoStartOnHandoff && qa.maxRepairs > 0;
  return (
    <div className="rs-input-notice">
      <strong>提交候选并进入 QA</strong>
      <p>
        提交时，服务会从开发工作目录为指定文件建立快照。{recipient.name}{" "}
        自动测试这一版候选。
      </p>
      {qa.files?.length > 0 && (
        <p>
          <code>{qa.files.join("、")}</code>
        </p>
      )}
      <p>
        {canRepair
          ? "QA 失败会退回本版及回执。在授权范围内，开发可自动修复并提交新候选，最多 " +
            qa.maxRepairs +
            " 次。"
          : "测试失败会把本版退回开发，等待修订和重新提交。"}
      </p>
    </div>
  );
}
function verifiedHealthLink(record) {
  if (
    record?.op !== "verify" ||
    record.status !== "succeeded" ||
    record.exitCode !== 0 ||
    record.canRead !== true ||
    !record.candidate?.digest ||
    typeof record.output !== "string"
  )
    return null;
  // stdout and stderr can contain warning lines alongside the verifier's JSON record.
  const output = record.output.trim();
  const lines = output.includes("\n")
    ? [output, ...output.split("\n").reverse()]
    : [output];
  for (const line of lines) {
    if (!line.trimStart().startsWith("{")) continue;
    try {
      const proof = JSON.parse(line);
      if (
        proof.candidateDigest !== record.candidate.digest ||
        typeof proof.healthUrl !== "string"
      )
        continue;
      const url = new URL(proof.healthUrl);
      if (
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        !url.username &&
        !url.password &&
        !url.href.split("#")[0].includes("?")
      )
        return url.href;
    } catch {
      /* Non-JSON or invalid URLs remain visible as ordinary command output. */
    }
  }
  return null;
}
function CommandReceipt({ op, record }) {
  const status = record?.status;
  const healthLink = verifiedHealthLink(record);
  return (
    <section className="rs-receipt">
      <header>
        <strong>{opLabels[op]}</strong>
        <span
          className={
            "rs-chip " +
            (status === "failed" || status === "unknown"
              ? "error"
              : status === "running"
                ? "active"
                : "")
          }
        >
          {record ? outcomeLabels[status] || status : "暂无命令回执"}
        </span>
      </header>
      {record && record.canRead === true && (
        <>
          <dl>
            {record.target && (
              <>
                <dt>执行目标</dt>
                <dd>{record.target}</dd>
              </>
            )}
            {record.argv?.length > 0 && (
              <>
                <dt>命令参数</dt>
                <dd>
                  <code>{JSON.stringify(record.argv)}</code>
                </dd>
              </>
            )}
            {record.exitCode != null && (
              <>
                <dt>退出码</dt>
                <dd>{record.exitCode}</dd>
              </>
            )}
            {record.id && (
              <>
                <dt>回执编号</dt>
                <dd>
                  <code>{record.id}</code>
                </dd>
              </>
            )}
            {record.createdAt && (
              <>
                <dt>开始时间</dt>
                <dd>
                  <time dateTime={record.createdAt}>
                    {new Date(record.createdAt).toLocaleString("zh-CN", {
                      hour12: false,
                    })}
                  </time>
                </dd>
              </>
            )}
            {record.completedAt && (
              <>
                <dt>回执时间</dt>
                <dd>
                  <time dateTime={record.completedAt}>
                    {new Date(record.completedAt).toLocaleString("zh-CN", {
                      hour12: false,
                    })}
                  </time>
                </dd>
              </>
            )}
          </dl>
          {healthLink && (
            <a
              className="rs-link"
              href={healthLink}
              target="_blank"
              rel="noopener noreferrer"
            >
              查看测试环境健康状态 ↗
            </a>
          )}
          {record.output && (
            <details
              open={
                status === "failed" || status === "unknown" ? true : undefined
              }
            >
              <summary>执行输出</summary>
              <pre>{record.output}</pre>
            </details>
          )}
        </>
      )}
      {record?.canRead === false && (
        <small>本次命令的明细仅对获授权成员可见。</small>
      )}
    </section>
  );
}
function DeliveryReceipts({ run, role, user }) {
  const qa = role.delivery.kind === "qa";
  const records = (run.deliveryActions || []).filter(
    (a) => a.roleId === role.id,
  );
  const canSeeTarget =
    role.assigneeId === user.id ||
    records.some((a) => a.canRead === true) ||
    run.artifacts.some((a) => a.toRoleId === role.id && a.canRead === true);
  const attempts = new Map();
  for (const job of run.handoffJobs || []) {
    if (job.roleId === role.id)
      attempts.set(job.id, {
        job,
        records: [],
        artifactId: job.artifactId,
        revision: job.revision,
      });
  }
  for (const rec of records) {
    if (!attempts.has(rec.jobId))
      attempts.set(rec.jobId, {
        records: [],
        artifactId: rec.artifactId,
        revision: rec.revision,
      });
    attempts.get(rec.jobId).records.push(rec);
  }
  const list = [...attempts.entries()].reverse();
  return (
    <section className="rs-delivery">
      <header className="rs-section-head">
        <div>
          <h2>{qa ? "候选测试回执" : "发布与验证回执"}</h2>
          <p className="rs-note">
            {qa
              ? "测试结果绑定本次提交的候选快照。"
              : "部署与部署后的验证分别记录命令结果。"}
          </p>
          {!qa && canSeeTarget && role.delivery.target && (
            <p className="rs-note">配置目标 · {role.delivery.target}</p>
          )}
        </div>
      </header>
      {!list.length && (
        <div className="rs-attempt">
          <p className="rs-note">
            {qa ? "等待开发提交候选。" : "等待 QA 交付通过测试的候选。"}
          </p>
        </div>
      )}
      {list.map(([id, attempt], index) => {
        const { job, artifactId, revision } = attempt;
        const input = run.artifacts.find(
          (a) => a.id === artifactId && a.revision === revision,
        );
        const snapshot =
          attempt.records.find((a) => a.canRead === true && a.candidate)
            ?.candidate || (input?.canRead === true ? input.candidate : null);
        const ops = qa ? ["test"] : ["deploy", "verify"];
        const failedTest =
          qa &&
          attempt.records.some((a) => a.op === "test" && a.status === "failed");
        const repair =
          failedTest &&
          (run.handoffJobs || []).find(
            (j) =>
              j.trigger === "return" &&
              j.artifactId === artifactId &&
              j.revision === revision,
          );
        const next =
          failedTest &&
          run.artifacts.find(
            (a) => a.id === artifactId && a.supersedesRevision === revision,
          );
        return (
          <details
            key={id}
            className="rs-attempt"
            open={index === 0 ? true : undefined}
          >
            <summary>
              {index === 0 ? "最近一次" : "历史记录"} ·{" "}
              {input?.canRead === true ? input.title : "输入产物"} v{revision}
            </summary>
            <div className="rs-attempt-body">
              {job && (
                <small>角色回合 · {jobLabels[job.status] || job.status}</small>
              )}
              <Snapshot candidate={snapshot} />
              <div className={"rs-proof" + (qa ? " single" : "")}>
                {ops.flatMap((op) => {
                  const receipts = attempt.records.filter((a) => a.op === op);
                  return receipts.length
                    ? receipts.map((a) => (
                        <CommandReceipt key={a.id} op={op} record={a} />
                      ))
                    : [<CommandReceipt key={op} op={op} />];
                })}
              </div>
              {failedTest && (
                <p className="rs-note">
                  {repair
                    ? "修复回合 · " +
                      (jobLabels[repair.status] || repair.status)
                    : input?.status === "returned"
                      ? "本版测试失败，已退回开发。"
                      : "请核对本版失败输出。"}
                  {next &&
                    " 已提交修订 v" +
                      next.revision +
                      "，复测结果以该版本的回执为准。"}
                </p>
              )}
            </div>
          </details>
        );
      })}
    </section>
  );
}
function Handoff({
  run,
  role,
  recipient,
  original,
  selectedText,
  onClose,
  onSaved,
}) {
  const [base] = useState(original);
  const [title, setTitle] = useState(
    base?.title ||
      (run.phase === "implementation" ? "实施结果" : role.output) ||
      "工作产物",
  );
  const [body, setBody] = useState(selectedText || base?.body || "");
  const [values, setValues] = useState(() => ({ ...base?.fields }));
  const [summary, setSummary] = useState("");
  const [preview, setPreview] = useState(false),
    [localError, setLocalError] = useState("");
  const command = useCommand();
  const required =
    run.phase === "implementation" ? [] : role.requiredFields || [];
  const keys = [...new Set([...required, ...Object.keys(base?.fields || {})])];
  const path =
    "/runs/" + encoded(run.id) + "/roles/" + encoded(role.id) + "/artifacts";
  function validate(e) {
    e.preventDefault();
    if (!title.trim() || !body.trim() || !summary.trim()) {
      setLocalError("请填写产物名称、正文和交接摘要。");
      return;
    }
    const missing = required.find((key) => !fieldValue(values, key).trim());
    if (missing) {
      setLocalError("请填写「" + missing + "」。");
      return;
    }
    setLocalError("");
    setPreview(true);
  }
  async function submit() {
    const fields = Object.fromEntries(
      keys.map((key) => [key, fieldValue(values, key)]),
    );
    if (
      await command.send(path, {
        title: title.trim(),
        body,
        fields,
        summary,
        baseRevision: base?.revision ?? 0,
      })
    )
      onSaved();
  }
  return (
    <Dialog
      title={preview ? "交接预览" : "准备产物"}
      busy={command.busy}
      onClose={onClose}
    >
      {preview ? (
        <>
          <p className="rs-live">
            {role.name} <ArrowRight size={14} /> {recipient.name}
          </p>
          <h3>
            {title} <small>v{base ? base.revision + 1 : 1}</small>
          </h3>
          <div className="rs-doc">{body}</div>
          <Properties
            values={Object.fromEntries(
              keys.map((k) => [k, fieldValue(values, k)]),
            )}
          />
          <dl>
            <div>
              <dt>交接摘要</dt>
              <dd>{summary}</dd>
            </div>
          </dl>
          <CandidateNotice role={role} recipient={recipient} />
          <p className="rs-privacy">
            {recipient.name}
            {recipient.delivery?.kind === "qa"
              ? "将收到以上产物、交接摘要和候选快照。"
              : "只会收到以上正文、字段和摘要。"}
            私有对话、工具日志和登录凭据不会随产物交接。
            {recipient.kind === "agent" &&
              recipient.autoStartOnHandoff &&
              !isDeliveryGate(recipient) &&
              " 提交后服务将为该角色安排自动回合。"}
          </p>
          {command.error && (
            <p className="rs-error" role="alert">
              {command.error}
            </p>
          )}
          <div className="rs-dialog-foot">
            <Button disabled={command.busy} onClick={() => setPreview(false)}>
              返回修改
            </Button>
            <Button primary disabled={command.busy} onClick={submit}>
              {command.busy ? "正在提交…" : "确认提交并交接"}
              <ArrowRight />
            </Button>
          </div>
        </>
      ) : (
        <form className="rs-form" onSubmit={validate}>
          {run.phase === "implementation" && run.approvedDesign && (
            <p className="rs-privacy">
              本次交付实施结果，依据已批准的设计 v{run.approvedDesign.revision}
              。接收人是 {recipient.name}。
            </p>
          )}
          {base && (
            <p className="rs-privacy">
              修订 v{base.revision}
              {feedbackOf(base) ? " · " + feedbackOf(base) : ""}
            </p>
          )}
          <label>
            产物名称
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            正文或固定版本引用
            <textarea
              required
              rows="5"
              placeholder="只填写准备交付给下一位的内容"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          {keys.map((key) => (
            <label key={key}>
              {key}
              <textarea
                required={required.includes(key)}
                aria-label={key}
                rows="2"
                value={fieldValue(values, key)}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [key]: e.target.value }))
                }
              />
            </label>
          ))}
          <label>
            交接摘要
            <textarea
              required
              rows="2"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="本版改变了什么？下一位需要处理什么？"
            />
          </label>
          {localError && (
            <p className="rs-error" role="alert">
              {localError}
            </p>
          )}
          <div className="rs-dialog-foot">
            <button type="submit" className="rs-button primary">
              预览交接 <ArrowRight size={15} />
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
function EditDesign({ artifact, sender, onSave, onCancel, command }) {
  const [title, setTitle] = useState(artifact.title);
  const [body, setBody] = useState(artifact.body);
  const [summary, setSummary] = useState(artifact.summary);
  const [fields, setFields] = useState(() => ({ ...artifact.fields }));
  const [error, setError] = useState("");
  const required = sender.requiredFields || [];
  const keys = [
    ...new Set([...required, ...Object.keys(artifact.fields || {})]),
  ];
  const changed =
    title !== artifact.title ||
    body !== artifact.body ||
    summary !== artifact.summary ||
    keys.some((k) => fieldValue(fields, k) !== fieldValue(artifact.fields, k));
  function save(e) {
    e.preventDefault();
    const missing = required.find((key) => !fieldValue(fields, key).trim());
    if (!body.trim() || !title.trim() || !summary.trim() || missing) {
      setError(
        missing
          ? "请填写「" + missing + "」。"
          : "请填写标题、正文和交接摘要。",
      );
      return;
    }
    if (changed) onSave({ title, body, summary, fields });
  }
  return (
    <form className="rs-form" onSubmit={save}>
      <p className="rs-privacy">
        正在编辑已提交的 v{artifact.revision}
        。保存后将产生待审新版，原版及其来源仍可查阅。
      </p>
      <label>
        设计标题
        <input
          required
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        设计正文
        <textarea
          required
          rows="7"
          aria-label="设计正文"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      {keys.map((key) => (
        <label key={key}>
          {key}
          <textarea
            required={required.includes(key)}
            aria-label={key}
            rows="2"
            value={fieldValue(fields, key)}
            onChange={(e) =>
              setFields((v) => ({ ...v, [key]: e.target.value }))
            }
          />
        </label>
      ))}
      <label>
        交接摘要
        <textarea
          aria-label="交接摘要"
          required
          rows="2"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
      </label>
      {(error || command.error) && (
        <p className="rs-error" role="alert">
          {error || command.error}
        </p>
      )}
      <div className="rs-dialog-foot">
        <Button disabled={command.busy} onClick={onCancel}>
          返回审阅
        </Button>
        <button
          className="rs-button primary"
          type="submit"
          disabled={command.busy || !changed}
        >
          {command.busy ? "保存中…" : "保存为 v" + (artifact.revision + 1)}
        </button>
      </div>
    </form>
  );
}
function Review({
  run,
  role,
  user,
  artifact,
  history,
  onClose,
  onSaved,
  onRevised,
  onVersion,
  autoWorking,
}) {
  const [feedback, setFeedback] = useState("");
  const [editing, setEditing] = useState(false);
  const command = useCommand();
  const prior = newest(history.filter((v) => v.revision < artifact.revision));
  const latest = newest(history);
  const terminal = run.roles.at(-1)?.id === role.id;
  const sender = run.roles.find((r) => r.id === artifact.fromRoleId);
  const recipient = run.roles.find((r) => r.id === artifact.toRoleId);
  const design =
    role.reviewMode === "design" && (artifact.phase || "handoff") === "handoff";
  const canReview =
    artifact.canRead !== false &&
    !isDeliveryGate(recipient) &&
    artifact.toRoleId === role.id &&
    role.assigneeId === user.id &&
    run.currentRoleId === role.id &&
    run.status === "active" &&
    artifact.status === "pending" &&
    (latest?.revision || artifact.revision) === artifact.revision &&
    (run.phase || "handoff") === (artifact.phase || "handoff") &&
    !autoWorking;
  const approved =
    run.approvedDesign?.artifactId === artifact.id &&
    run.approvedDesign?.revision === artifact.revision;
  async function decide(action, patch = {}) {
    if (!canReview || (action === "return" && !feedback.trim())) return;
    const payload = {
      artifactId: artifact.id,
      revision: artifact.revision,
      action,
      ...patch,
    };
    if (action === "return") payload.feedback = feedback;
    const receipt = await command.send(
      "/runs/" + encoded(run.id) + "/review",
      payload,
    );
    if (!receipt) return;
    if (action === "edit") {
      const next = receipt.result?.artifacts?.find(
        (v) =>
          v.id === artifact.id &&
          v.supersedesRevision === artifact.revision &&
          v.canRead !== false,
      );
      if (next) {
        onRevised(next);
        return;
      }
    }
    onSaved();
  }
  return (
    <Dialog
      title={
        editing && canReview ? "编辑设计 v" + artifact.revision : artifact.title
      }
      onClose={onClose}
      busy={command.busy}
    >
      {editing && design && canReview ? (
        <EditDesign
          artifact={artifact}
          sender={sender}
          command={command}
          onCancel={() => setEditing(false)}
          onSave={(patch) => decide("edit", patch)}
        />
      ) : (
        <>
          <p className="rs-note">
            {sender?.name} → {recipient?.name} · v{artifact.revision} ·{" "}
            {artifactText[artifact.status] || artifact.status}
          </p>
          {artifact.editedBy && (
            <p className="rs-note">
              修改人 ·{" "}
              {artifact.editedBy === user.id ? user.name : artifact.editedBy} ·
              基于 v{artifact.supersedesRevision}
            </p>
          )}
          {approved && (
            <p className="rs-privacy">
              已批准 v{artifact.revision} 作为实施依据。
            </p>
          )}
          {artifact.status === "superseded" &&
            latest?.revision > artifact.revision && (
              <p className="rs-note">
                这是保留的历史版本。{" "}
                <button
                  type="button"
                  className="rs-link"
                  onClick={() => onVersion(latest)}
                >
                  查看 v{latest.revision}
                </button>
              </p>
            )}
          {isDeliveryGate(recipient) && (
            <p className="rs-privacy">
              这份输入由 {recipient.name} 根据候选的实际命令回执处理。
            </p>
          )}
          <Snapshot
            candidate={artifact.canRead === true ? artifact.candidate : null}
          />
          <div className="rs-doc">{artifact.body}</div>
          <Properties values={artifact.fields} />
          <dl>
            <div>
              <dt>交接摘要</dt>
              <dd>{artifact.summary}</dd>
            </div>
            {feedbackOf(artifact) && (
              <div>
                <dt>退回意见</dt>
                <dd>{feedbackOf(artifact)}</dd>
              </div>
            )}
          </dl>
          {prior && (
            <details>
              <summary>查看上一版 v{prior.revision}</summary>
              <div className="rs-doc">{prior.body}</div>
              <Properties values={prior.fields} />
              {feedbackOf(prior) && <p>{feedbackOf(prior)}</p>}
            </details>
          )}
          {canReview && (
            <>
              {design && (
                <p className="rs-privacy">
                  确认后，{sender.name} 将在该节点的原会话中按设计 v
                  {artifact.revision} 开工。实施结果交回 {role.name} 签收。
                </p>
              )}
              <label>
                退回意见
                <textarea
                  rows="2"
                  aria-label="退回意见"
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="请说明哪一处需要修订"
                />
              </label>
              {command.error && (
                <p className="rs-error" role="alert">
                  {command.error}
                </p>
              )}
              <div className="rs-dialog-foot">
                {design && (
                  <Button
                    disabled={command.busy}
                    onClick={() => setEditing(true)}
                  >
                    编辑此版设计
                  </Button>
                )}
                <Button
                  disabled={command.busy || !feedback.trim()}
                  onClick={() => decide("return")}
                >
                  退回修订
                </Button>
                <Button
                  primary
                  disabled={command.busy}
                  onClick={() => decide(design ? "confirm_start" : "accept")}
                >
                  <Check />
                  {design
                    ? "确认 v" + artifact.revision + " 并开工"
                    : terminal
                      ? "签收并结束本次运行"
                      : "签收此版本"}
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </Dialog>
  );
}
const jobLabels = {
  queued: "待自动启动",
  prepared: "待自动启动",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
const jobInProgress = (job) =>
  ["queued", "prepared", "running"].includes(job.status);
function Automation({ jobs, run, role }) {
  if (!jobs.length) return null;
  return (
    <section className="rs-automation">
      <h2>自动交接</h2>
      {jobs.map((job) => {
        const input = run.artifacts.find(
          (a) => a.id === job.artifactId && a.revision === job.revision,
        );
        const sourceId =
          job.trigger === "handoff" ? input?.fromRoleId : input?.toRoleId;
        const source = run.roles.find((n) => n.id === sourceId),
          target = run.roles.find((n) => n.id === job.roleId);
        return (
          <div key={job.id} className="rs-job">
            <div className="rs-job-head">
              <strong>
                {job.trigger === "confirm_start"
                  ? "确认开工"
                  : job.trigger === "return"
                    ? "退回修订"
                    : "产物交接"}
              </strong>
              <span
                className={
                  "rs-chip " +
                  (job.status === "failed"
                    ? "error"
                    : jobInProgress(job)
                      ? "active"
                      : "")
                }
              >
                {jobLabels[job.status] || job.status}
              </span>
            </div>
            <p>
              {source?.name || "上游角色"} → {target?.name || role.name}
            </p>
            {input && (
              <small>
                {input.canRead === false ? "交接产物" : input.title} · v
                {job.revision}
              </small>
            )}
            {isDeliveryGate(target) && role.id !== target.id && (
              <a
                className="rs-link"
                href={
                  "#/runs/" + encoded(run.id) + "/roles/" + encoded(target.id)
                }
              >
                查看命令回执 →
              </a>
            )}
          </div>
        );
      })}
    </section>
  );
}
function Thread({
  user,
  role,
  sessionState,
  current,
  onDraftArtifact,
  canSubmit,
  jobs,
  activeJob,
}) {
  const [input, setInput] = useState("");
  const [fileError, setFileError] = useState("");
  const [acknowledged, setAcknowledged] = useState(null);
  const fileInput = useRef(null);
  const [formBusy, setFormBusy] = useState(false);
  const bodyRef = useRef(null),
    pinned = useRef(true),
    mounted = useRef(false);
  const { session, error, ready, opening, reload } = sessionState;
  const turnCommand = useCommand();
  const [resolveError, setResolveError] = useState(""),
    [resolving, setResolving] = useState(false);
  const resolvingRef = useRef(false);
  const messages = session?.messages || [],
    turns = session?.turns || [];
  const turnsById = new Map(turns.map((t) => [t.requestId, t]));
  const latest = turns.at(-1);
  const jobsByRequestId = new Map(jobs.map((job) => [job.requestId, job]));
  const waiting = hasPending(session);
  // Bridge the brief gap between a POST receipt and the authoritative GET snapshot.
  const reconciling = Boolean(
    acknowledged && !turns.some((t) => t.requestId === acknowledged),
  );
  const canSend =
    current &&
    ready &&
    !activeJob &&
    !waiting &&
    !reconciling &&
    !turnCommand.busy;
  const path =
    "/runs/" + encoded(role.runId) + "/roles/" + encoded(role.id) + "/turns";
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (pinned.current && bodyRef.current)
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages.length, latest?.status]);
  async function send(e) {
    e.preventDefault();
    const text = input;
    if (!canSend || !text.trim()) return;
    // Only lock the submitted text while waiting. Pending replies still allow drafting the next turn.
    setFormBusy(true);
    const receipt = await turnCommand.send(path, { text });
    if (!mounted.current) return;
    if (receipt) {
      setInput("");
      setAcknowledged(receipt.requestId || null);
      pinned.current = true;
    }
    setFormBusy(false);
    reload();
  }
  async function attach(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setFileError("");
    if (
      !/^text\//.test(file.type) &&
      !/\.(txt|md|csv|json|yaml|yml|log)$/i.test(file.name)
    ) {
      setFileError("请选择文本文件，或在输入区粘贴其他文件的引用。");
      return;
    }
    try {
      const text = await file.slice(0, 24000).text();
      if (mounted.current)
        setInput((prev) =>
          [
            prev,
            "文件 " +
              file.name +
              "\n" +
              text +
              (file.size > 24000 ? "\n（摘录前 24 KB）" : ""),
          ]
            .filter(Boolean)
            .join("\n"),
        );
    } catch {
      if (mounted.current) setFileError("无法读取文件，可以直接粘贴摘录。");
    }
  }
  const runtime = session?.runtimeState;
  const uncertain = waiting && (runtime === "unknown" || runtime === "timeout");
  const permission = waiting && runtime === "permission";
  const pendingTurn = turns.find((t) => t.status === "pending");
  async function resolvePending() {
    if (!uncertain || !current || !pendingTurn || resolvingRef.current) return;
    resolvingRef.current = true;
    setResolving(true);
    setResolveError("");
    try {
      await api(path + "/" + encoded(pendingTurn.requestId) + "/resolve", {
        method: "POST",
        body: { confirmed: true },
      });
    } catch (e) {
      if (mounted.current) setResolveError(errorText(e));
    } finally {
      resolvingRef.current = false;
      if (mounted.current) {
        setResolving(false);
        reload();
      }
    }
  }
  const pendingStatus = permission
    ? "等待工具授权"
    : uncertain
      ? "结果待核对"
      : runtime === "running"
        ? "执行中"
        : "等待执行器回执";
  const status = opening
    ? "正在打开会话"
    : error
      ? "连接异常"
      : waiting
        ? pendingStatus
        : reconciling
          ? "正在核对回合"
          : activeJob
            ? jobLabels[activeJob.status]
            : latest
              ? turnText[latest.status] || latest.status
              : ready
                ? "等待输入"
                : "读取中";
  return (
    <section className="rs-thread">
      <header className="rs-section-head">
        <div className="rs-live">
          <Terminal size={16} />
          <h2>角色会话</h2>
        </div>
        <div className="rs-live">
          <span
            className={"rs-chip " + (error ? "error" : waiting ? "active" : "")}
          >
            {status}
          </span>
          <Button
            subtle
            onClick={reload}
            disabled={opening}
            title="刷新会话"
            aria-label="刷新会话"
          >
            <RefreshCw />
          </Button>
        </div>
      </header>
      {permission && (
        <p className="rs-note" role="status">
          请到执行工作机，在 Paseo
          原会话中处理工具权限请求。授权后，此处会更新同一回合的结果。
          {session?.nativeSessionId && (
            <span>
              {" "}
              会话 ID · <code>{session.nativeSessionId}</code>
            </span>
          )}
        </p>
      )}
      {uncertain && (
        <div className="rs-reconcile" role="status">
          <strong>
            {runtime === "timeout" ? "等待回执超时" : "尚未确认本轮结果"}
          </strong>
          <p>请先在 Paseo 核对原会话。服务会按原消息标识对账，不会自动重发。</p>
          {current && (
            <Button onClick={resolvePending} disabled={resolving}>
              {resolving ? "正在对账…" : "已核对原会话，结束待定回合"}
            </Button>
          )}
          {resolveError && (
            <p className="rs-error" role="alert">
              {resolveError}
            </p>
          )}
        </div>
      )}
      {waiting && session?.runtimeMessage && (
        <p className="rs-note">{session.runtimeMessage}</p>
      )}
      {error && (
        <p className="rs-error" role="alert">
          {error}{" "}
          <button type="button" className="rs-link" onClick={reload}>
            重试
          </button>
        </p>
      )}
      <div
        className="rs-messages"
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 55;
        }}
        aria-live="polite"
        aria-label="会话消息"
      >
        {messages.length === 0 && (
          <p className="rs-note">
            {opening
              ? "正在连接此节点的执行环境…"
              : activeJob
                ? "已安排自动回合，等待服务端记录。"
                : ready
                  ? "此会话尚无消息。可以直接提交本次任务或会议摘录。"
                  : "等待服务端会话记录。"}
          </p>
        )}
        {messages.map((m) => {
          const agent = m.role === "assistant";
          const sourceTurn = turnsById.get(m.requestId);
          const autoInput = !agent && jobsByRequestId.has(m.requestId);
          return (
            <article
              className={"rs-message " + (agent ? "agent" : "person")}
              key={m.requestId + "-" + m.role}
            >
              <span className="rs-symbol" aria-hidden="true">
                {agent ? <Terminal size={15} /> : <UserRound size={14} />}
              </span>
              <div>
                <div className="rs-msg-author">
                  {agent ? role.name : autoInput ? "自动交接" : user.name}
                  <small>
                    {agent
                      ? "执行器回复"
                      : autoInput
                        ? "按提交版本启动"
                        : "成员输入"}
                  </small>
                </div>
                <div className="rs-msg-body">{m.text}</div>
                {agent && canSubmit && (
                  <button
                    type="button"
                    className="rs-link"
                    onClick={() => onDraftArtifact(m.text)}
                  >
                    作为产物草稿 →
                  </button>
                )}
                {!agent && sourceTurn?.status === "failed" && (
                  <p className="rs-error" role="status">
                    执行失败 · {sourceTurn.error || "执行器未返回错误说明"}
                  </p>
                )}
                {!agent && sourceTurn?.status === "pending" && (
                  <p className="rs-note">已记录输入，等待执行器回执。</p>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {current ? (
        <form className="rs-compose" onSubmit={send}>
          <label htmlFor="role-session-input">仅此角色的私人会话</label>
          <textarea
            id="role-session-input"
            value={input}
            readOnly={formBusy}
            maxLength={80000}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (canSend) e.currentTarget.form.requestSubmit();
              }
            }}
            placeholder={
              waiting || activeJob
                ? "可先写下下一轮补充，待本轮结束后发送…"
                : "直接输入任务，粘贴会议摘录、文档链接或文件引用…"
            }
          />
          {fileError && (
            <p className="rs-error" role="alert">
              {fileError}
            </p>
          )}
          {turnCommand.error && (
            <p className="rs-error" role="alert">
              {turnCommand.error}
            </p>
          )}
          <div className="rs-actions">
            <span className="rs-note">链接按引用发送</span>
            <input
              ref={fileInput}
              type="file"
              accept="text/*,.md,.yaml,.yml,.log,.json,.csv"
              hidden
              onChange={attach}
            />
            <Button
              subtle
              disabled={formBusy}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip />
              附文本
            </Button>
            <button
              type="submit"
              className="rs-button primary"
              disabled={!canSend || !input.trim()}
            >
              <Send />
              {turnCommand.busy ? "发送中" : "发送"}
            </button>
          </div>
        </form>
      ) : (
        <p className="rs-note">
          本次工作已离开该节点，可查看已保存的会话记录。
        </p>
      )}
    </section>
  );
}
function Panel({ run, role, user, refreshRun, onBack }) {
  const [modal, setModal] = useState(null);
  const [syncError, setSyncError] = useState("");
  const alive = useRef(false),
    refresher = useRef(refreshRun),
    sync = useRef(null);
  refresher.current = refreshRun;
  const refresh = useCallback(async () => {
    if (sync.current) return sync.current;
    sync.current = Promise.resolve()
      .then(() => refresher.current())
      .then(() => {
        if (alive.current) setSyncError("");
      })
      .catch((e) => {
        if (alive.current) setSyncError(errorText(e));
      })
      .finally(() => {
        sync.current = null;
      });
    return sync.current;
  }, []);
  const mine = role.assigneeId === user.id,
    current = run.status === "active" && run.currentRoleId === role.id;
  const privateAgent = mine && role.kind === "agent";
  const gate = isDeliveryGate(role);
  const index = run.roles.findIndex((r) => r.id === role.id);
  const recipient = index >= 0 ? run.roles[index + 1] : null;
  const ownPath =
    "/runs/" + encoded(run.id) + "/roles/" + encoded(role.id) + "/session";
  const relevant = run.artifacts
    .filter((v) => v.fromRoleId === role.id || v.toRoleId === role.id)
    .slice()
    .reverse();
  const inputs = new Set(relevant.map((v) => v.id + "/" + v.revision));
  const relatedJobs = (run.handoffJobs || [])
    .filter(
      (job) =>
        job.roleId === role.id ||
        inputs.has(job.artifactId + "/" + job.revision),
    )
    .slice()
    .reverse();
  const ownJobs = relatedJobs.filter((job) => job.roleId === role.id);
  const activeJob = ownJobs.find(jobInProgress);
  const busyJobs =
    relatedJobs.some(jobInProgress) ||
    (run.deliveryActions || []).some(
      (a) =>
        a.status === "running" &&
        (a.roleId === role.id || inputs.has(a.artifactId + "/" + a.revision)),
    );
  const block = run.deliveryBlock;
  const showBlock =
    block &&
    (block.roleId === role.id || relatedJobs.some((j) => j.id === block.jobId));
  const sessionState = useSession(
    ownPath,
    user.id,
    privateAgent,
    privateAgent && current && !gate && !ownJobs.length,
    Boolean(activeJob),
  );
  const approval = run.approvedDesign;
  const approvedArtifact =
    approval &&
    relevant.find(
      (v) =>
        v.id === approval.artifactId &&
        v.revision === approval.revision &&
        v.canRead !== false,
    );
  const pendingIncoming = relevant.some(
    (v) => v.toRoleId === role.id && v.status === "pending",
  );
  const returned = newest(
    relevant.filter(
      (v) =>
        v.fromRoleId === role.id &&
        v.status === "returned" &&
        (v.phase || "handoff") === (run.phase || "handoff") &&
        v.canRead !== false,
    ),
  );
  const canSubmit =
    mine &&
    current &&
    recipient &&
    !gate &&
    !pendingIncoming &&
    !activeJob &&
    !hasPending(sessionState.session) &&
    (!privateAgent || Boolean(sessionState.session));
  const selectedVersion =
    modal?.type === "review"
      ? relevant.find(
          (v) => v.id === modal.id && v.revision === modal.revision,
        ) || modal.savedVersion
      : null;
  const inspected = selectedVersion?.canRead !== false ? selectedVersion : null;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (run.status !== "active") return;
    const timer = setInterval(
      () => {
        if (!document.hidden) refresh();
      },
      busyJobs ? 1200 : 5000,
    );
    return () => clearInterval(timer);
  }, [run.status, refresh, busyJobs]);
  const close = () => setModal(null);
  const afterSave = () => {
    close();
    refresh();
    sessionState.reload();
  };
  function showVersion(version) {
    if (version.canRead === false) return;
    setModal({
      type: "review",
      id: version.id,
      revision: version.revision,
      savedVersion: version,
    });
  }
  function openRevision(version) {
    showVersion(version);
    refresh();
  }
  return (
    <section className="rs">
      <header className="rs-head">
        <div>
          {onBack && (
            <Button subtle onClick={onBack}>
              <ArrowLeft />
              返回运行
            </Button>
          )}
          <div className="rs-title">
            <h1>{role.name}</h1>
            <span className={"rs-chip " + (current ? "active" : "")}>
              {run.status === "completed"
                ? "已归档"
                : current
                  ? "当前经办"
                  : "查看记录"}
            </span>
          </div>
          <p className="rs-subtitle">
            {run.teamName} / {run.title} · 流程 v{run.teamVersion}
          </p>
        </div>
        {mine && recipient && !gate && (
          <Button
            primary
            disabled={!canSubmit}
            onClick={() => setModal({ type: "handoff", body: "" })}
          >
            <Send />
            {activeJob
              ? "等待自动回合"
              : pendingIncoming
                ? "先审阅收到的产物"
                : run.phase === "implementation"
                  ? "提交实施结果"
                  : "提交产物"}
          </Button>
        )}
      </header>
      <RoleFacts user={user} role={role} environment={role.environmentName} />
      {syncError && (
        <p className="rs-error" role="alert">
          运行状态刷新失败 · {syncError}{" "}
          <button type="button" className="rs-link" onClick={refresh}>
            重新获取
          </button>
        </p>
      )}
      {showBlock && (
        <div role="status" className="rs-reconcile">
          <strong>交付流程等待处理</strong>
          <p>
            {block.canRead === false
              ? "等待负责成员核对交付证据。"
              : block.reason || "请核对当前候选的命令回执。"}
          </p>
        </div>
      )}
      {gate && <DeliveryReceipts run={run} role={role} user={user} />}
      <div className="rs-grid">
        {privateAgent ? (
          <Thread
            user={user}
            role={{ ...role, runId: run.id }}
            current={current}
            sessionState={sessionState}
            canSubmit={canSubmit}
            jobs={ownJobs}
            activeJob={activeJob}
            onDraftArtifact={(text) =>
              setModal({ type: "handoff", body: text })
            }
          />
        ) : !mine ? (
          <section className="rs-thread rs-private">
            <ShieldCheck size={20} />
            <h2>成员私有会话</h2>
            <p className="rs-note">
              此节点由其他成员负责。你可以查看本次运行中获准共享的交接记录。
            </p>
          </section>
        ) : (
          <section className="rs-thread">
            <header className="rs-section-head">
              <h2>
                {role.reviewMode === "design"
                  ? run.phase === "implementation"
                    ? "实施结果验收"
                    : "设计评审"
                  : "人工审阅"}
              </h2>
              <UserRound size={16} />
            </header>
            <div className="rs-messages">
              {pendingIncoming ? (
                <>
                  <p>
                    {role.reviewMode === "design" &&
                    run.phase !== "implementation"
                      ? "请审阅提交的设计。可以直接修订、退回，或批准本版开工。"
                      : "请核对此版本的正文、必填字段和摘要。"}
                  </p>
                  {relevant
                    .filter(
                      (v) =>
                        v.toRoleId === role.id &&
                        v.status === "pending" &&
                        v.canRead !== false,
                    )
                    .map((v) => (
                      <Button
                        primary
                        key={v.id + ":" + v.revision}
                        onClick={() =>
                          setModal({
                            type: "review",
                            id: v.id,
                            revision: v.revision,
                          })
                        }
                      >
                        审阅《{v.title}》v{v.revision} <ArrowRight />
                      </Button>
                    ))}
                </>
              ) : (
                <p className="rs-note">
                  {run.status === "completed"
                    ? "本次运行已结束，可查看历史交接。"
                    : "暂无待签收的交接产物。"}
                </p>
              )}
            </div>
          </section>
        )}
        <aside className="rs-rail">
          {approvedArtifact && (
            <section>
              <h2>实施依据</h2>
              <button
                type="button"
                className="rs-record"
                onClick={() => showVersion(approvedArtifact)}
              >
                <small>负责人已批准</small>
                <strong>
                  {approvedArtifact.title} · v{approvedArtifact.revision}
                </strong>
              </button>
            </section>
          )}
          <Automation jobs={relatedJobs} run={run} role={role} />
          <section>
            <h2>本次交接</h2>
            {relevant.length ? (
              relevant.map((v) => (
                <button
                  type="button"
                  className="rs-record"
                  key={v.id + ":" + v.revision}
                  disabled={v.canRead === false}
                  onClick={() =>
                    setModal({ type: "review", id: v.id, revision: v.revision })
                  }
                >
                  <small>
                    {v.toRoleId === role.id ? "收到" : "发出"} ·{" "}
                    {
                      run.roles.find(
                        (n) =>
                          n.id ===
                          (v.toRoleId === role.id ? v.fromRoleId : v.toRoleId),
                      )?.name
                    }
                  </small>
                  <strong>
                    {v.canRead === false ? "交接产物" : v.title} · v{v.revision}
                  </strong>
                  <span className="rs-chip">
                    {artifactText[v.status] || v.status}
                  </span>
                </button>
              ))
            ) : (
              <p className="rs-note">尚无显式提交的产物。</p>
            )}
          </section>
          {mine && (
            <section>
              <h2>角色配置</h2>
              <dl>
                <dt>职责</dt>
                <dd>{role.duty || "未填写"}</dd>
                <dt>交付物</dt>
                <dd>{role.output || "未填写"}</dd>
                {role.requiredFields?.length > 0 && (
                  <>
                    <dt>必填字段</dt>
                    <dd>{role.requiredFields.join("、")}</dd>
                  </>
                )}
                {privateAgent && sessionState.session?.nativeSessionId && (
                  <>
                    <dt>执行器会话 ID</dt>
                    <dd>{sessionState.session.nativeSessionId}</dd>
                  </>
                )}
              </dl>
            </section>
          )}
        </aside>
      </div>
      {modal?.type === "handoff" && canSubmit && (
        <Handoff
          run={run}
          role={role}
          recipient={recipient}
          original={returned}
          selectedText={modal.body}
          onClose={close}
          onSaved={afterSave}
        />
      )}
      {inspected && (
        <Review
          key={inspected.id + ":" + inspected.revision}
          run={run}
          role={role}
          user={user}
          artifact={inspected}
          history={[
            ...relevant.filter(
              (v) =>
                v.id === inspected.id &&
                v.canRead !== false &&
                v.revision !== inspected.revision,
            ),
            inspected,
          ]}
          onClose={close}
          onSaved={afterSave}
          onRevised={openRevision}
          onVersion={showVersion}
          autoWorking={Boolean(activeJob) || hasPending(sessionState.session)}
        />
      )}
    </section>
  );
}
export default function RoleSession(props) {
  const { run, role, user } = props;
  if (!run || !role || !user)
    return <p className="rs-note">请先选择一次运行和角色节点。</p>;
  return <Panel key={[user.id, run.id, role.id].join(":")} {...props} />;
}
