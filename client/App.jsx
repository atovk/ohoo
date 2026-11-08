import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Check,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  Copy,
  FolderOpen,
  GitBranch,
  Inbox,
  Layers3,
  LayoutDashboard,
  ListOrdered,
  LoaderCircle,
  LogOut,
  Menu,
  Monitor,
  Network,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  TerminalSquare,
  UserRound,
  Users,
  Workflow,
  X,
} from "lucide-react";
import { api } from "./api";
import RoleSession from "./RoleSession";
import TeamEditor from "./components/TeamEditor";
import "./workbench.css";

const sections = [
  ["home", "工作台", LayoutDashboard],
  ["teams", "团队", Network],
  ["runs", "运行记录", Activity],
  ["inbox", "待我签收", Inbox],
  ["environment", "执行环境", Monitor],
  ["members", "成员", Users],
];
const enc = encodeURIComponent;
const href = (...parts) =>
  "#/" + parts.map((part) => enc(String(part))).join("/");
function useLocation() {
  const current = () => {
    try {
      return (window.location.hash.slice(1).replace(/^\/+|\/+$/g, "") || "home")
        .split("/")
        .map(decodeURIComponent);
    } catch {
      return ["home"];
    }
  };
  const [parts, setParts] = useState(current);
  useEffect(() => {
    const change = () => {
      setParts(current());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  return parts;
}
function navigate(...parts) {
  window.location.hash = href(...parts);
}
const deliveryNames = {
  test: "QA 测试",
  deploy: "测试环境部署",
  verify: "部署后验证",
};
const receiptStatus = {
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  unknown: "结果待核对",
};
function deliveryEvidence(run) {
  const roles = run.roles,
    qaIndex = roles.findIndex((r) => r.delivery?.kind === "qa");
  if (qaIndex < 1) return null;
  const qa = roles[qaIndex],
    dev = roles[qaIndex - 1],
    sre = roles[qaIndex + 1];
  if (sre?.delivery?.kind !== "release") return null;
  const arts = run.artifacts || [],
    actions = run.deliveryActions || [];
  const candidate = arts.findLast(
    (a) => a.fromRoleId === dev.id && a.toRoleId === qa.id,
  );
  const releaseInput =
    candidate &&
    arts
      .slice(arts.indexOf(candidate) + 1)
      .findLast((a) => a.fromRoleId === qa.id && a.toRoleId === sre.id);
  const receipt = (op, artifact) =>
    artifact
      ? actions.findLast(
          (a) =>
            a.op === op &&
            a.artifactId === artifact.id &&
            a.revision === artifact.revision,
        )
      : undefined;
  return {
    qa,
    dev,
    sre,
    candidate,
    releaseInput,
    actions,
    test: receipt("test", candidate),
    deploy: receipt("deploy", releaseInput),
    verify: receipt("verify", releaseInput),
    block: run.deliveryBlock,
  };
}
function verifiedRelease(data) {
  const receipts = [data.test, data.deploy, data.verify];
  if (
    receipts.some(
      (action) =>
        action?.status !== "succeeded" ||
        (action.exitCode != null && action.exitCode !== 0),
    )
  )
    return false;
  const digests = [
    data.candidate?.candidate?.digest,
    data.releaseInput?.candidate?.digest,
    ...receipts.map((a) => a.candidate?.digest),
  ].filter(Boolean);
  return new Set(digests).size <= 1;
}
function deploymentStatus(run, delivery) {
  if (delivery.block) return "交付流程待处理";
  if (run.status === "completed")
    return verifiedRelease(delivery) ? "已验证并关闭" : "关闭回执待核对";
  if (
    run.currentRoleId === delivery.dev.id &&
    delivery.candidate?.status === "returned"
  )
    return "QA 退回开发修复";
  const action =
    delivery.verify ||
    delivery.deploy ||
    (run.currentRoleId === delivery.qa.id && delivery.test);
  if (action)
    return `${deliveryNames[action.op]} · ${receiptStatus[action.status] || action.status}`;
  if (run.currentRoleId === delivery.sre.id) return "等待测试环境部署";
  if (run.currentRoleId === delivery.qa.id) return "等待候选测试";
  return null;
}
function runStatus(run) {
  const pipeline = deliveryEvidence(run);
  if (pipeline) {
    const stage = deploymentStatus(run, pipeline);
    if (stage) return stage;
  }
  if (run.status === "completed") return "已完成";
  const role = run.roles?.find((n) => n.id === run.currentRoleId);
  const pending = run.artifacts?.find(
    (a) => a.status === "pending" && a.toRoleId === role?.id,
  );
  if (pending) {
    if (pending.phase === "implementation") return "待验收实施结果";
    if (role?.reviewMode === "design") return "待负责人评审";
    return "待签收";
  }
  if (run.phase === "implementation" && run.approvedDesign) return "已确认开工";
  if (role?.kind === "human") return "待真人处理";
  return "进行中";
}
const time = (value) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date)
    : "";
};
function Person({ id, members }) {
  return <>{members.find((member) => member.id === id)?.name || "未知成员"}</>;
}
function Btn({ children, primary = false, ...props }) {
  return (
    <button
      type="button"
      className={"wb-btn" + (primary ? " wb-is-primary" : "")}
      {...props}
    >
      {children}
    </button>
  );
}
function Empty({ icon: Icon = Layers3, title, detail, children }) {
  return (
    <div className="wb-empty">
      <span>
        <Icon size={24} />
      </span>
      <h3>{title}</h3>
      {detail && <p>{detail}</p>}
      {children}
    </div>
  );
}
function Alert({ message, onRetry }) {
  if (!message) return null;
  return (
    <div className="wb-notice wb-error" role="alert">
      <CircleAlert size={16} />
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="wb-link" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}
function PageHead({ title, description, children }) {
  return (
    <header className="wb-head">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="wb-actions">{children}</div>}
    </header>
  );
}
function RunRows({ runs, members }) {
  return (
    <div className="wb-list">
      {runs.map((run) => {
        const role = run.roles.find((r) => r.id === run.currentRoleId);
        return (
          <a href={href("runs", run.id)} className="wb-row" key={run.id}>
            <span className="wb-row-icon">
              <GitBranch size={18} />
            </span>
            <div className="wb-row-title">
              <strong>{run.title}</strong>
              <small>
                {run.teamName} · v{run.teamVersion}
                {role ? ` · ${role.name}` : ""}
              </small>
            </div>
            {role && (
              <span className="wb-row-person">
                <Person id={role.assigneeId} members={members} />
              </span>
            )}
            <span
              className={`wb-badge ${run.status === "completed" ? "wb-done" : "wb-active"}`}
            >
              {runStatus(run)}
            </span>
            <ChevronRight size={15} />
          </a>
        );
      })}
    </div>
  );
}
function useData(user) {
  const [data, setData] = useState({ members: [], teams: [], runs: [] }),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false);
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const order = ++seq.current;
    try {
      const [members, teams, runs] = await Promise.all([
        api("/members"),
        api("/teams"),
        api("/runs"),
      ]);
      if (order === seq.current) {
        setData({ members, teams, runs });
        setError("");
        setLoaded(true);
      }
      return { members, teams, runs };
    } catch (err) {
      if (order === seq.current) {
        if ([401, 403].includes(err.status))
          setData({ members: [], teams: [], runs: [] });
        setError(err.message);
        setLoaded(true);
      }
      throw err;
    }
  }, [user.id]);
  useEffect(() => {
    let mounted = true,
      running = false;
    const load = () => {
      if (!mounted || running) return;
      running = true;
      refresh()
        .catch(() => {})
        .finally(() => {
          running = false;
        });
    };
    load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 6000);
    return () => {
      mounted = false;
      seq.current++;
      clearInterval(id);
    };
  }, [refresh]);
  function acceptTeam(team) {
    seq.current++;
    setData((d) => ({
      ...d,
      teams: [team, ...d.teams.filter((t) => t.id !== team.id)],
    }));
  }
  const acceptRun = useCallback((run) => {
    if (!run) return;
    seq.current++;
    setData((prev) => ({
      ...prev,
      runs: prev.runs.some((r) => r.id === run.id)
        ? prev.runs.map((r) => (r.id === run.id ? run : r))
        : [run, ...prev.runs],
    }));
  }, []);
  return { ...data, error, loaded, refresh, acceptTeam, acceptRun };
}
function useDetail(id, poll) {
  const [item, setItem] = useState(null),
    [error, setError] = useState("");
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    if (!id) return null;
    const order = ++seq.current;
    try {
      const value = await api(`/runs/${enc(id)}`);
      if (order === seq.current) {
        setItem(value);
        setError("");
      }
      return value;
    } catch (err) {
      if (order === seq.current) {
        if ([401, 403, 404].includes(err.status)) setItem(null);
        setError(err.message);
      }
      throw err;
    }
  }, [id]);
  useEffect(() => {
    setItem(null);
    setError("");
    if (!id) return;
    let busy = false;
    const load = () => {
      if (busy) return;
      busy = true;
      refresh()
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    };
    load();
    const timer = poll
      ? setInterval(() => {
          if (document.visibilityState === "visible") load();
        }, 4500)
      : null;
    return () => {
      seq.current++;
      clearInterval(timer);
    };
  }, [id, refresh, poll]);
  return { item: item?.id === id ? item : null, error, refresh };
}
function Home({ data, user, inbox, onLaunch }) {
  const active = data.runs.filter((r) => r.status !== "completed"),
    current = active
      .filter(
        (r) =>
          r.roles.find((n) => n.id === r.currentRoleId)?.assigneeId === user.id,
      )
      .slice(0, 5);
  return (
    <section className="wb-page">
      <PageHead title="我的工作台" description={`${user.name} · 本机协作空间`}>
        {data.teams.length ? (
          <Btn primary onClick={() => onLaunch(null)}>
            <Plus size={16} />
            发起工作
          </Btn>
        ) : (
          user.role === "owner" && (
            <Btn primary onClick={() => navigate("teams", "new")}>
              <Plus size={16} />
              创建团队
            </Btn>
          )
        )}
      </PageHead>
      <div className="wb-metrics">
        {[
          [Network, "可见团队", data.teams.length, "teams"],
          [Activity, "进行中", active.length, "runs"],
          [ClipboardCheck, "待我签收", inbox.length, "inbox"],
        ].map(([Icon, label, num, page]) => (
          <a key={page} href={href(page)} className="wb-metric">
            <span>
              <Icon size={17} />
              {label}
            </span>
            <strong>{num}</strong>
            <ArrowUpRight size={15} />
          </a>
        ))}
      </div>
      <div className="wb-dashboard-grid">
        <section className="wb-panel">
          <div className="wb-section-title">
            <h2>我负责的工作</h2>
          </div>
          {current.length ? (
            <RunRows runs={current} members={data.members} />
          ) : (
            <Empty
              icon={ClipboardCheck}
              title="当前没有轮到你的工作"
              detail={
                data.teams.length
                  ? "发起一次运行后，可以从这里进入当前角色。"
                  : "建立团队并配置角色后，就可以发起第一项工作。"
              }
            >
              {!data.teams.length && user.role === "owner" && (
                <a className="wb-link" href={href("teams", "new")}>
                  创建第一个团队 <ArrowRight size={13} />
                </a>
              )}
            </Empty>
          )}
        </section>
        <section className="wb-panel">
          <div className="wb-section-title">
            <h2>我的团队</h2>
            <a className="wb-link" href={href("teams")}>
              查看全部 <ChevronRight size={14} />
            </a>
          </div>
          {data.teams.length ? (
            <div className="wb-list">
              {data.teams.slice(0, 4).map((t) => (
                <a className="wb-row" key={t.id} href={href("teams", t.id)}>
                  <span className="wb-row-icon">
                    <Workflow size={17} />
                  </span>
                  <div className="wb-row-title">
                    <strong>{t.name}</strong>
                    <small>
                      {t.roles.length} 个角色 · v{t.version}
                    </small>
                  </div>
                  <ChevronRight size={15} />
                </a>
              ))}
            </div>
          ) : (
            <Empty
              icon={Users}
              title="还没有团队"
              detail={
                user.role === "owner"
                  ? "团队保存可复用的分工与交接顺序。"
                  : "团队负责人将你加入团队后，它会出现在这里。"
              }
            />
          )}
        </section>
      </div>
      <section className="wb-panel">
        <div className="wb-section-title">
          <h2>最近运行</h2>
          <a className="wb-link" href={href("runs")}>
            全部运行 <ChevronRight size={14} />
          </a>
        </div>
        {data.runs.length ? (
          <RunRows runs={data.runs.slice(0, 5)} members={data.members} />
        ) : (
          <Empty icon={ListOrdered} title="暂无运行记录" />
        )}
      </section>
    </section>
  );
}
function TeamsPage({ data, user }) {
  const [search, setSearch] = useState("");
  const teams = data.teams.filter((t) =>
    [t.name, t.goal, ...t.roles.map((n) => n.name)].some((v) =>
      v?.toLowerCase().includes(search.trim().toLowerCase()),
    ),
  );
  return (
    <section className="wb-page">
      <PageHead
        title="团队"
        description={`${data.teams.length} 个可访问的协作团队`}
      >
        {user.role === "owner" && (
          <Btn primary onClick={() => navigate("teams", "new")}>
            <Plus size={16} />
            创建团队
          </Btn>
        )}
      </PageHead>
      <label className="wb-search">
        <Search size={16} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索团队或角色"
          aria-label="搜索团队"
        />
      </label>
      {!teams.length ? (
        <Empty
          icon={Network}
          title={data.teams.length ? "没有匹配的团队" : "尚未建立团队"}
          detail={
            data.teams.length
              ? "试试其他名称或角色。"
              : user.role === "owner"
                ? "从团队名称、成员和角色分工开始。"
                : "团队负责人添加你后便可访问。"
          }
        >
          {!data.teams.length && user.role === "owner" && (
            <a className="wb-link" href={href("teams", "new")}>
              创建团队 <ArrowRight size={13} />
            </a>
          )}
        </Empty>
      ) : (
        <div className="wb-grid wb-directory">
          {teams.map((t) => (
            <a
              className="wb-card wb-directory-card"
              href={href("teams", t.id)}
              key={t.id}
            >
              <div className="wb-card-top">
                <span className="wb-row-icon">
                  <Network size={20} />
                </span>
                <span className="wb-badge">v{t.version}</span>
              </div>
              <h2>{t.name}</h2>
              <p>{t.goal}</p>
              <div className="wb-mini-route">
                {t.roles.slice(0, 3).map((r, i) => (
                  <React.Fragment key={r.id}>
                    {i > 0 && <ArrowRight size={12} />}
                    <span>{r.name}</span>
                  </React.Fragment>
                ))}
                {t.roles.length > 3 && <small>+{t.roles.length - 3}</small>}
              </div>
              <footer>
                <span>
                  <Users size={14} />
                  {t.memberIds.length} 位成员
                </span>
                <ArrowUpRight size={15} />
              </footer>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
function DesignConnections({ roles }) {
  const pairs = roles.flatMap((role, i) =>
    role.reviewMode === "design" && roles[i - 1]?.kind === "agent"
      ? [[role, roles[i - 1]]]
      : [],
  );
  if (!pairs.length) return null;
  return (
    <div className="wb-stage-flow" aria-label="设计评审的条件交接">
      {pairs.map(([reviewer, developer]) => (
        <div key={reviewer.id}>
          <GitBranch size={15} />
          <strong>确认开工后</strong>
          <span>{reviewer.name}</span>
          <ArrowRight size={14} />
          <span>{developer.name} · 按批准版本实施</span>
        </div>
      ))}
    </div>
  );
}
const jobStatuses = {
  queued: "排队中",
  running: "运行中",
  completed: "回合已结束",
  failed: "执行失败",
  cancelled: "已取消",
};
const jobActions = {
  handoff: "收到上游交接",
  return: "收到退回意见",
  confirm_start: "按批准方案开始实施",
};
function ExecutionRecord({ run, members }) {
  const jobs = run.handoffJobs || [],
    approved = run.approvedDesign;
  if (!approved && !jobs.length) return null;
  const reference =
    approved &&
    run.artifacts.find(
      (a) => a.id === approved.artifactId && a.revision === approved.revision,
    );
  return (
    <section className="wb-panel wb-implementation">
      <div className="wb-section-title">
        <h2>{approved ? "实施与自动回合" : "自动交接"}</h2>
      </div>
      {approved && (
        <div className="wb-rule">
          <ShieldCheck size={17} />
          <div>
            <strong>
              已确认开工 ·{" "}
              {reference?.canRead !== false && reference?.title
                ? reference.title
                : "技术方案"}{" "}
              v{approved.revision}
            </strong>
            <p>
              <Person id={approved.approvedBy} members={members} />于{" "}
              {time(approved.approvedAt)}{" "}
              确认。实施产物与批准的设计版本分别记录。
            </p>
          </div>
        </div>
      )}
      {!!jobs.length && (
        <div className="wb-list">
          {jobs
            .slice()
            .reverse()
            .map((j) => {
              const role = run.roles.find((r) => r.id === j.roleId);
              return (
                <a
                  key={j.id}
                  href={href("runs", run.id, "roles", j.roleId)}
                  className="wb-row"
                >
                  <span className="wb-row-icon">
                    <TerminalSquare size={17} />
                  </span>
                  <div className="wb-row-title">
                    <strong>
                      {role?.name || "执行角色"} ·{" "}
                      {jobActions[j.trigger] || "自动回合"}
                    </strong>
                    <small>
                      依据产物 v{j.revision}
                      {j.createdAt ? " · " + time(j.createdAt) : ""}
                    </small>
                  </div>
                  <span className="wb-badge">
                    {jobStatuses[j.status] || j.status}
                  </span>
                  <ChevronRight size={15} />
                </a>
              );
            })}
        </div>
      )}
    </section>
  );
}
function DeliveryRules({ roles }) {
  const qa = roles.find((r) => r.delivery?.kind === "qa"),
    sre = roles.find((r) => r.delivery?.kind === "release");
  if (!qa && !sre) return null;
  return (
    <details className="wb-delivery-rules">
      <summary>候选、测试与发布规则</summary>
      {qa && (
        <div>
          <h3>{qa.name} · 测试</h3>
          <p>
            按 {qa.delivery.files.length} 个文件冻结候选，最多自动修复{" "}
            {qa.delivery.maxRepairs} 次。
          </p>
          <pre>{qa.delivery.files.join("\n")}</pre>
          <code>{JSON.stringify(qa.delivery.test)}</code>
        </div>
      )}
      {sre && (
        <div>
          <h3>{sre.name} · 发布</h3>
          <p>目标测试环境：{sre.delivery.target}</p>
          <dl>
            <div>
              <dt>部署命令</dt>
              <dd>
                <code>{JSON.stringify(sre.delivery.deploy)}</code>
              </dd>
            </div>
            <div>
              <dt>部署后验证</dt>
              <dd>
                <code>{JSON.stringify(sre.delivery.verify)}</code>
              </dd>
            </div>
          </dl>
        </div>
      )}
    </details>
  );
}
function Digest({ digest }) {
  return (
    <code className="wb-digest" title={digest}>
      {digest}
    </code>
  );
}
function DeliveryReceipts({ run }) {
  const data = deliveryEvidence(run);
  if (!data) return null;
  const {
    qa,
    dev,
    sre,
    candidate,
    releaseInput,
    actions,
    test,
    deploy,
    verify,
    block,
  } = data;
  const frozen = candidate?.candidate || test?.candidate;
  const phase = (op, artifact, action, empty) => {
    const s = action?.status || "pending";
    return (
      <div key={op} className="wb-gate-step" data-state={s}>
        <span className="wb-gate-label">{deliveryNames[op]}</span>
        <strong>{action ? receiptStatus[s] || s : empty}</strong>
        <small>
          {artifact
            ? `${artifact.canRead === false ? "交接产物" : artifact.title || "交接产物"} v${artifact.revision}`
            : "尚无交接版本"}
        </small>
        {action && Number.isInteger(action.exitCode) && (
          <small>退出码 {action.exitCode}</small>
        )}
      </div>
    );
  };
  return (
    <section className="wb-panel wb-delivery-results">
      <div className="wb-section-title">
        <h2>候选与执行回执</h2>
        <span className="wb-badge">{sre.delivery.target}</span>
      </div>
      <div className="wb-candidate-head">
        {candidate ? (
          <>
            <strong>
              {candidate.canRead === false
                ? "候选交接"
                : candidate.title || "候选版本"}{" "}
              · v{candidate.revision}
            </strong>
            {frozen?.digest ? (
              <Digest digest={frozen.digest} />
            ) : (
              <span className="wb-muted">
                {candidate.canRead === false
                  ? "摘要仅对交接成员可见"
                  : "暂无可见的候选摘要"}
              </span>
            )}
            {frozen?.files?.length > 0 && (
              <details>
                <summary>候选文件 · {frozen.files.length} 项</summary>
                <pre>{frozen.files.join("\n")}</pre>
              </details>
            )}
          </>
        ) : (
          <span className="wb-muted">等待{dev.name}提交候选文件。</span>
        )}
      </div>
      <div className="wb-gate-steps">
        {phase("test", candidate, test, candidate ? "等待测试" : "等待候选")}
        {phase(
          "deploy",
          releaseInput,
          deploy,
          releaseInput ? "等待部署" : "等待 QA 交接",
        )}
        {phase(
          "verify",
          releaseInput,
          verify,
          deploy?.status === "succeeded" ? "等待验证" : "等待部署成功",
        )}
      </div>
      {candidate?.status === "returned" && (
        <p className="wb-notice">
          {qa.name}已退回 v{candidate.revision}。
          {candidate.canRead === true && candidate.feedback
            ? candidate.feedback
            : "请查看对应测试回执。"}
        </p>
      )}
      {block && (
        <p className="wb-notice wb-error" role="status">
          <CircleAlert size={15} />
          {(block.canRead === true && block.reason) ||
            "本次交付已暂停，需核对执行回执。"}
        </p>
      )}
      {run.status === "completed" && verifiedRelease(data) && (
        <p className="wb-delivery-close">
          <Check size={14} />
          {sre.delivery.target} 已有同一候选的成功验证回执，本次运行已关闭。
        </p>
      )}
      {!!actions.length && (
        <div className="wb-delivery-history">
          <h3>历次执行</h3>
          {actions
            .slice()
            .reverse()
            .map((a) => (
              <details key={a.id}>
                <summary>
                  <span>{deliveryNames[a.op] || a.op}</span>
                  <b>{receiptStatus[a.status] || a.status}</b>
                  <small>
                    产物 v{a.revision} · {time(a.createdAt)}
                  </small>
                </summary>
                {a.canRead !== true ? (
                  <p className="wb-muted">
                    具体命令、输出和候选清单仅对有权成员可见。
                  </p>
                ) : (
                  <>
                    <dl>
                      <div>
                        <dt>角色</dt>
                        <dd>
                          {run.roles.find((r) => r.id === a.roleId)?.name ||
                            "执行角色"}
                        </dd>
                      </div>
                      {a.target && (
                        <div>
                          <dt>目标</dt>
                          <dd>{a.target}</dd>
                        </div>
                      )}
                      {a.candidate?.digest && (
                        <div>
                          <dt>候选摘要</dt>
                          <dd>
                            <Digest digest={a.candidate.digest} />
                          </dd>
                        </div>
                      )}
                      {Array.isArray(a.argv) && (
                        <div>
                          <dt>执行参数</dt>
                          <dd>
                            <code>{JSON.stringify(a.argv)}</code>
                          </dd>
                        </div>
                      )}
                      {Number.isInteger(a.exitCode) && (
                        <div>
                          <dt>退出码</dt>
                          <dd>{a.exitCode}</dd>
                        </div>
                      )}
                      {a.completedAt && (
                        <div>
                          <dt>结束时间</dt>
                          <dd>{time(a.completedAt)}</dd>
                        </div>
                      )}
                    </dl>
                    {a.output && (
                      <pre className="wb-command-output">{a.output}</pre>
                    )}
                  </>
                )}
              </details>
            ))}
        </div>
      )}
    </section>
  );
}
function RoleMap({
  roles,
  current,
  completed = false,
  members,
  runId,
  onRole,
}) {
  return (
    <div className="wb-run-map" aria-label="角色交接顺序">
      {roles.map((r, i) => {
        const human = r.kind === "human",
          isCurrent = !completed && r.id === current;
        const node = (
          <>
            <div className="wb-node-top">
              {human ? <UserRound size={16} /> : <TerminalSquare size={16} />}
              <span>{human ? "真人" : "Agent"}</span>
              {isCurrent && <b>当前角色</b>}
            </div>
            <strong>{r.name}</strong>
            <small>
              <Person id={r.assigneeId} members={members} />
              {!human && r.provider ? ` · ${r.provider}` : ""}
            </small>
            {r.output && <span className="wb-node-output">{r.output}</span>}
            {r.autoStartOnHandoff && <small>收到产物后自动启动</small>}
            {r.delivery?.kind === "qa" && (
              <small>测试候选 · 限 {r.delivery.maxRepairs} 次返工</small>
            )}
            {r.delivery?.kind === "release" && (
              <small>部署与验证 · {r.delivery.target}</small>
            )}
            {r.reviewMode === "design" && <small>设计评审 · 可确认开工</small>}
          </>
        );
        const classes = `wb-run-node ${human ? "wb-human" : ""} ${isCurrent ? "wb-current" : ""}`;
        return (
          <React.Fragment key={r.id}>
            {i > 0 && (
              <span className="wb-node-arrow" aria-hidden="true">
                <ArrowRight size={17} />
              </span>
            )}
            {runId ? (
              <a
                className={classes}
                href={href("runs", runId, "roles", r.id)}
                aria-label={`打开${r.name}角色工作面板`}
              >
                {node}
              </a>
            ) : (
              <button
                type="button"
                className={classes}
                aria-label={`查看${r.name}的运行`}
                onClick={() => onRole(r)}
              >
                {node}
              </button>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
function TeamDetail({ team, data, user, onLaunch }) {
  const [selected, setSelected] = useState(null);
  const runsFor = (role) =>
    data.runs.filter(
      (r) => r.teamId === team.id && r.roles.some((n) => n.id === role.id),
    );
  function chooseRole(role) {
    const matches = runsFor(role),
      active = matches.filter(
        (r) => r.status === "active" && r.currentRoleId === role.id,
      );
    if (active.length === 1) {
      navigate("runs", active[0].id, "roles", role.id);
      return;
    }
    setSelected(role);
  }
  return (
    <section className="wb-page">
      <a className="wb-link" href={href("teams")}>
        <ArrowLeft size={14} />
        团队目录
      </a>
      <PageHead title={team.name} description={team.goal}>
        {user.role === "owner" && (
          <Btn onClick={() => navigate("teams", team.id, "edit")}>
            <Settings2 size={15} />
            编辑流程
          </Btn>
        )}
        <Btn primary onClick={() => onLaunch(team.id)}>
          <Play size={15} />
          发起工作
        </Btn>
      </PageHead>
      <section className="wb-panel">
        <div className="wb-section-title">
          <h2>团队流程</h2>
          <span className="wb-badge">当前版本 v{team.version}</span>
        </div>
        <RoleMap
          roles={team.roles}
          members={data.members}
          onRole={chooseRole}
        />
        <DesignConnections roles={team.roles} />
        <DeliveryRules roles={team.roles} />
        {selected && (
          <div className="wb-panel wb-role-chooser">
            <div className="wb-section-title">
              <h3>{selected.name}的运行</h3>
              <button
                type="button"
                className="wb-icon-btn"
                aria-label="收起角色运行"
                onClick={() => setSelected(null)}
              >
                <X size={15} />
              </button>
            </div>
            {runsFor(selected).map((r) => (
              <a
                key={r.id}
                className="wb-row"
                href={href("runs", r.id, "roles", selected.id)}
              >
                <div className="wb-row-title">
                  <strong>{r.title}</strong>
                  <small>
                    v{r.teamVersion} · {runStatus(r)}
                  </small>
                </div>
                <ChevronRight size={15} />
              </a>
            ))}
            {!runsFor(selected).length && (
              <p className="wb-muted">还没有包含此角色的运行。</p>
            )}
            <Btn onClick={() => onLaunch(team.id)}>
              <Plus size={14} />
              发起新工作
            </Btn>
          </div>
        )}
      </section>
      <section className="wb-panel">
        <div className="wb-section-title">
          <h2>角色与交接</h2>
          <span>{team.roles.length} 个角色</span>
        </div>
        <div className="wb-list">
          {team.roles.map((n, i) => (
            <div className="wb-row" key={n.id}>
              <span className="wb-row-icon">
                {n.kind === "agent" ? (
                  <TerminalSquare size={17} />
                ) : (
                  <UserRound size={17} />
                )}
              </span>
              <div className="wb-row-title">
                <strong>{n.name}</strong>
                <small>{n.duty}</small>
              </div>
              <div className="wb-row-side">
                <strong>{n.output}</strong>
                <small>
                  {team.roles[i + 1]
                    ? `交给 ${team.roles[i + 1].name}`
                    : "最终交付"}
                </small>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="wb-panel">
        <div className="wb-section-title">
          <h2>团队运行</h2>
        </div>
        {data.runs.some((r) => r.teamId === team.id) ? (
          <RunRows
            runs={data.runs.filter((r) => r.teamId === team.id)}
            members={data.members}
          />
        ) : (
          <Empty
            icon={Activity}
            title="还没有运行"
            detail="发起一项具体委托，团队将按当前版本协作。"
          />
        )}
      </section>
    </section>
  );
}
function RunsPage({ data, onLaunch }) {
  const [filter, setFilter] = useState("全部");
  const runs = data.runs.filter(
    (r) =>
      filter === "全部" ||
      (filter === "已完成"
        ? r.status === "completed"
        : r.status !== "completed"),
  );
  return (
    <section className="wb-page">
      <PageHead title="运行记录" description="每次运行使用发起时的团队流程。">
        {data.teams.length > 0 && (
          <Btn primary onClick={() => onLaunch(null)}>
            <Plus size={15} />
            发起工作
          </Btn>
        )}
      </PageHead>
      <div className="wb-tabs">
        {["全部", "进行中", "已完成"].map((f) => (
          <button
            type="button"
            key={f}
            aria-pressed={f === filter}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="wb-panel">
        {runs.length ? (
          <RunRows runs={runs} members={data.members} />
        ) : (
          <Empty icon={Activity} title="没有符合条件的运行" />
        )}
      </div>
    </section>
  );
}
function RunPage({ run, members }) {
  const current = run.roles.find((n) => n.id === run.currentRoleId),
    artifacts = run.artifacts || [];
  return (
    <section className="wb-page">
      <a className="wb-link" href={href("runs")}>
        <ArrowLeft size={14} />
        全部运行
      </a>
      <PageHead
        title={run.title}
        description={`${run.teamName} · 流程 v${run.teamVersion} · ${time(run.createdAt)}`}
      >
        {current && run.status !== "completed" && (
          <Btn
            primary
            onClick={() => navigate("runs", run.id, "roles", current.id)}
          >
            进入{current.name}
            <ArrowRight size={15} />
          </Btn>
        )}
      </PageHead>
      <section className="wb-panel">
        <div className="wb-section-title">
          <h2>本次运行画布</h2>
          <span className="wb-badge wb-active">{runStatus(run)}</span>
        </div>
        <RoleMap
          roles={run.roles}
          current={run.currentRoleId}
          completed={run.status === "completed"}
          members={members}
          runId={run.id}
        />
        <DesignConnections roles={run.roles} />
      </section>
      <DeliveryReceipts run={run} />
      <ExecutionRecord run={run} members={members} />
      <section className="wb-panel">
        <div className="wb-section-title">
          <h2>交付产物</h2>
          <span>{artifacts.length} 个版本</span>
        </div>
        {artifacts.length ? (
          <ArtifactRows run={run} artifacts={artifacts} members={members} />
        ) : (
          <Empty
            icon={FolderOpen}
            title="暂无已提交的产物"
            detail="成员在角色工作面板确认提交后，产物版本会出现在这里。"
          />
        )}
      </section>
      {run.history?.length > 0 && (
        <section className="wb-panel">
          <div className="wb-section-title">
            <h2>运行时间线</h2>
          </div>
          <ol className="wb-history">
            {run.history
              .slice()
              .reverse()
              .map((event, i) => (
                <li key={event.id || i}>
                  <span>
                    {typeof event === "string"
                      ? event
                      : `${eventLabel[event.type] || event.type}${event.revision ? ` · v${event.revision}` : ""}${event.summary ? " · " + event.summary : ""}`}
                  </span>
                  <small>
                    {event.roleId
                      ? `${run.roles.find((r) => r.id === event.roleId)?.name || "角色"} · `
                      : ""}
                    {event.actorId && (
                      <>
                        <Person id={event.actorId} members={members} /> ·{" "}
                      </>
                    )}
                    {time(event.createdAt || event.time)}
                  </small>
                </li>
              ))}
          </ol>
        </section>
      )}
    </section>
  );
}
const artifactStatus = {
  pending: "待签收",
  returned: "已退回",
  accepted: "已签收",
  superseded: "已有新修订",
};
const eventLabel = {
  started: "发起运行",
  submitted: "提交产物",
  returned: "退回产物",
  accepted: "签收产物",
  completed: "结束运行",
  auto_accepted: "上游产物已自动接收",
  edited: "负责人保存设计修订",
  confirm_start: "负责人确认此版设计并开工",
};
function ArtifactRows({ run, artifacts, members }) {
  return (
    <div className="wb-list">
      {artifacts
        .slice()
        .reverse()
        .map((a) => {
          const target =
              a.status === "returned"
                ? a.fromRoleId
                : a.toRoleId || a.fromRoleId,
            from = run.roles.find((n) => n.id === a.fromRoleId),
            to = run.roles.find((n) => n.id === a.toRoleId);
          return (
            <div className="wb-revision-row" key={`${a.id}/${a.revision}`}>
              <a
                className="wb-row"
                href={href("runs", run.id, "roles", target)}
              >
                <span className="wb-row-icon">
                  <FolderOpen size={17} />
                </span>
                <div className="wb-row-title">
                  <strong>
                    {a.canRead === false ? "交接记录" : a.title || "交付产物"}{" "}
                    <small>v{a.revision}</small>
                  </strong>
                  <small>
                    {from?.name || "发起角色"} → {to?.name || "最终交付"}
                    {a.phase === "implementation"
                      ? " · 实施结果"
                      : to?.reviewMode === "design"
                        ? " · 技术方案"
                        : ""}
                  </small>
                </div>
                {a.canRead !== false && a.editedBy && (
                  <small className="wb-row-person">
                    <Person id={a.editedBy} members={members} /> 修订
                    {a.supersedesRevision
                      ? ` · 基于 v${a.supersedesRevision}`
                      : ""}
                  </small>
                )}
                <span
                  className={`wb-badge ${a.status === "pending" ? "wb-active" : ""}`}
                >
                  {run.approvedDesign?.artifactId === a.id &&
                  run.approvedDesign.revision === a.revision
                    ? "已批准开工"
                    : artifactStatus[a.status] || a.status}
                </span>
                <ChevronRight size={14} />
              </a>
              {a.canRead === true && a.candidate?.digest && (
                <p className="wb-art-candidate">
                  候选摘要 <Digest digest={a.candidate.digest} />
                </p>
              )}
              {a.canRead === true && (
                <details className="wb-revision-detail">
                  <summary>查看 v{a.revision} 正文与交接依据</summary>
                  <p className="wb-revision-body">{a.body}</p>
                  {Object.entries(a.fields || {}).map(([field, value]) => (
                    <p key={field}>
                      <strong>{field}</strong> · {value}
                    </p>
                  ))}
                  {a.summary && (
                    <p>
                      <strong>交接摘要</strong> · {a.summary}
                    </p>
                  )}
                  {a.feedback && (
                    <p>
                      <strong>退回意见</strong> · {a.feedback}
                    </p>
                  )}
                  {a.editedBy && (
                    <small>
                      <Person id={a.editedBy} members={members} />{" "}
                      保存了这一版设计。
                    </small>
                  )}
                </details>
              )}
            </div>
          );
        })}
    </div>
  );
}
function InboxPage({ entries }) {
  return (
    <section className="wb-page">
      <PageHead
        title="待我签收"
        description="核对交来的具体版本，评审设计或签收实施结果。"
      />
      <section className="wb-panel">
        {entries.length ? (
          <div className="wb-list">
            {entries.map(({ run, artifact, role }) => (
              <a
                className="wb-row"
                key={`${run.id}/${artifact.id}`}
                href={href("runs", run.id, "roles", role.id)}
              >
                <span className="wb-row-icon">
                  <Inbox size={18} />
                </span>
                <div className="wb-row-title">
                  <strong>
                    {artifact.title || "交付产物"} · v{artifact.revision}
                  </strong>
                  <small>
                    {run.title} / {role.name}
                  </small>
                </div>
                <span className="wb-badge wb-active">
                  {artifact.phase === "implementation"
                    ? "待验收"
                    : role.reviewMode === "design"
                      ? "待负责人评审"
                      : "待签收"}
                </span>
                <ChevronRight size={15} />
              </a>
            ))}
          </div>
        ) : (
          <Empty
            icon={ClipboardCheck}
            title="没有待签收的产物"
            detail="交给你负责角色的产物会出现在这里。"
          />
        )}
      </section>
    </section>
  );
}
function EnvironmentPage({ discovery, error, loading, refresh }) {
  const env = discovery?.environment;
  return (
    <section className="wb-page">
      <PageHead
        title="执行环境"
        description="查看本机实际发现的 coding agent 与可选模型。"
      >
        <Btn disabled={loading} onClick={refresh}>
          <RefreshCw size={15} />
          {loading ? "检测中…" : "重新检测"}
        </Btn>
      </PageHead>
      <Alert message={error} onRetry={refresh} />
      {discovery && (
        <>
          <section className="wb-panel wb-env-head">
            <div className="wb-row-icon">
              <Monitor size={23} />
            </div>
            <div>
              <h2>{env?.name || "本机环境"}</h2>
              <p>{env?.cwd || "未提供工作目录"}</p>
            </div>
            <span
              className={"wb-badge " + (discovery.online ? "wb-active" : "")}
            >
              {discovery.online ? "已连接" : "未连接"}
            </span>
          </section>
          {discovery.error && (
            <div className="wb-notice">{String(discovery.error)}</div>
          )}
          <section className="wb-panel">
            <div className="wb-section-title">
              <h2>已发现的执行器</h2>
              <span>{discovery.providers?.length || 0} 项</span>
            </div>
            {discovery.providers?.length ? (
              <div className="wb-list">
                {discovery.providers.map((p) => (
                  <div className="wb-row" key={p.id}>
                    <span className="wb-row-icon">
                      <TerminalSquare size={17} />
                    </span>
                    <div className="wb-row-title">
                      <strong>{p.label || p.id}</strong>
                      <small>
                        {p.models?.length
                          ? p.models.map((m) => m.label || m.id).join(" · ")
                          : "未返回模型目录"}
                      </small>
                      {p.diagnostic && <small>{String(p.diagnostic)}</small>}
                    </div>
                    <span className="wb-badge">{p.status}</span>
                  </div>
                ))}
              </div>
            ) : (
              <Empty
                icon={TerminalSquare}
                title="尚未发现可用执行器"
                detail="在执行主机完成安装与登录，然后重新检测。"
              />
            )}
          </section>
        </>
      )}
      {loading && !discovery && (
        <div className="wb-loading">
          <LoaderCircle size={18} />
          正在读取执行环境…
        </div>
      )}
    </section>
  );
}
function MembersPage({ user, members }) {
  const [invite, setInvite] = useState(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [copied, setCopied] = useState(false);
  async function create() {
    setBusy(true);
    setMessage("");
    setCopied(false);
    try {
      setInvite(await api("/invites", { method: "POST", body: {} }));
    } catch (err) {
      setMessage(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(invite.url);
      setCopied(true);
    } catch {
      setMessage("请选中链接并复制。");
    }
  }
  return (
    <section className="wb-page">
      <PageHead title="空间成员" description="同一实例中的成员与角色分工。">
        {user.role === "owner" && (
          <Btn primary disabled={busy} onClick={create}>
            <Plus size={15} />
            {busy ? "生成中…" : "生成邀请链接"}
          </Btn>
        )}
      </PageHead>
      <Alert message={message} />
      {invite && (
        <section className="wb-panel wb-invite">
          <div className="wb-section-title">
            <h2>一次性邀请链接</h2>
            {invite.expiresAt && <span>{time(invite.expiresAt)} 到期</span>}
          </div>
          <p>
            受邀成员可从另一浏览器或浏览器配置文件打开链接，建立自己的身份。
          </p>
          <div className="wb-invite-link">
            <input
              readOnly
              aria-label="一次性邀请链接"
              value={invite.url}
              onFocus={(e) => e.target.select()}
            />
            <Btn onClick={copy}>
              {copied ? <Check size={15} /> : <Copy size={15} />}{" "}
              {copied ? "已复制" : "复制"}
            </Btn>
          </div>
        </section>
      )}
      <section className="wb-panel">
        <div className="wb-section-title">
          <h2>成员</h2>
          <span>{members.length} 人</span>
        </div>
        <div className="wb-list">
          {members.map((m) => (
            <div className="wb-row" key={m.id}>
              <span className="wb-avatar">{m.name.slice(0, 1)}</span>
              <div className="wb-row-title">
                <strong>{m.name}</strong>
                <small>{m.role === "owner" ? "本机管理员" : "成员"}</small>
              </div>
              {m.id === user.id && <span className="wb-badge">我</span>}
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}
function LaunchDialog({ teams, initial, onClose, onDone }) {
  const [id, setId] = useState(initial || teams[0]?.id || ""),
    [title, setTitle] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const formRef = useRef(null),
    team = teams.find((t) => t.id === id);
  useEffect(() => {
    const previous = document.activeElement;
    formRef.current?.querySelector("input")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    function key(e) {
      if (e.key === "Escape" && !busy) onClose();
      if (e.key === "Tab") {
        const focusable = Array.from(
          formRef.current?.querySelectorAll(
            "button:not(:disabled),input,select",
          ) || [],
        );
        if (e.shiftKey && document.activeElement === focusable[0]) {
          e.preventDefault();
          focusable.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === focusable.at(-1)) {
          e.preventDefault();
          focusable[0]?.focus();
        }
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy, onClose]);
  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (!team || !title.trim()) {
      setError("选择团队并填写本次委托。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const run = await api(`/teams/${enc(team.id)}/runs`, {
        method: "POST",
        body: { title: title.trim() },
      });
      onDone(run);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }
  return (
    <div className="wb-dialog-overlay">
      <section
        className="wb-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wb-launch-title"
        ref={formRef}
      >
        <div className="wb-section-title">
          <h2 id="wb-launch-title">发起工作</h2>
          <button
            type="button"
            className="wb-icon-btn"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <form className="wb-form" onSubmit={submit}>
          <label className="wb-field">
            <span>使用团队</span>
            <select
              aria-label="使用团队"
              required
              value={id}
              onChange={(e) => setId(e.target.value)}
            >
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · v{t.version}
                </option>
              ))}
            </select>
          </label>
          <label className="wb-field">
            <span>本次委托</span>
            <input
              required
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="这次团队要交付什么？"
            />
          </label>
          {team && <p className="wb-muted">首个角色：{team.roles[0]?.name}</p>}
          <Alert message={error} />
          <div className="wb-actions">
            <Btn disabled={busy} onClick={onClose}>
              取消
            </Btn>
            <button
              type="submit"
              className="wb-btn wb-is-primary"
              disabled={busy}
            >
              {busy ? "正在发起…" : "发起工作"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
export default function App({ user, onLogout }) {
  const route = useLocation(),
    [page, id, sub, roleId] = route;
  const data = useData(user),
    detail = useDetail(page === "runs" && id ? id : null, sub !== "roles");
  const [mobile, setMobile] = useState(false),
    [launch, setLaunch] = useState(null),
    [discovery, setDiscovery] = useState(null),
    [dError, setDError] = useState(""),
    [detecting, setDetecting] = useState(false);
  const isOwner = user.role === "owner",
    activeTeam = data.teams.find((t) => t.id === id),
    section = sections.find(([key]) => key === page),
    discoverSeq = useRef(0);
  const reloadDiscovery = useCallback(
    async (cwd) => {
      if (!isOwner) return;
      const requested = typeof cwd === "string" ? cwd.trim() : "";
      const seq = ++discoverSeq.current;
      setDetecting(true);
      setDError("");
      try {
        const d = await api(
          "/providers" + (requested ? "?cwd=" + enc(requested) : ""),
        );
        const result = { ...d, requestedCwd: requested || d.environment?.cwd };
        if (discoverSeq.current === seq) setDiscovery(result);
        return result;
      } catch (err) {
        if (discoverSeq.current === seq) setDError(err.message);
      } finally {
        if (discoverSeq.current === seq) setDetecting(false);
      }
    },
    [isOwner],
  );
  useEffect(() => {
    if (
      isOwner &&
      (page === "environment" ||
        (page === "teams" && (id === "new" || sub === "edit")))
    )
      reloadDiscovery();
  }, [page, id, sub, isOwner, reloadDiscovery]);
  useEffect(() => {
    setMobile(false);
  }, [page, id, sub, roleId]);
  const inbox = data.runs.flatMap((run) =>
    (run.artifacts || []).flatMap((artifact) => {
      const role = run.roles.find((n) => n.id === artifact.toRoleId);
      return artifact.status === "pending" && role?.assigneeId === user.id
        ? [{ run, role, artifact }]
        : [];
    }),
  );
  const openLaunch = (id) => {
    if (data.teams.length) setLaunch({ id });
  };
  const refreshRun = useCallback(async () => {
    const result = await detail.refresh();
    data.acceptRun(result);
    return result;
  }, [detail.refresh, data.acceptRun]);
  function launchDone(run) {
    setLaunch(null);
    data.acceptRun(run);
    data.refresh().catch(() => {});
    navigate("runs", run.id);
  }
  const handleSave = (team) => {
    data.acceptTeam(team);
    navigate("teams", team.id);
    data.refresh().catch(() => {});
  };
  const noAccess = (
    <section className="wb-page">
      <Empty
        icon={ShieldCheck}
        title="无法打开此页面"
        detail="请检查访问权限或返回工作台。"
      >
        <a className="wb-link" href={href("home")}>
          返回工作台 <ArrowRight size={14} />
        </a>
      </Empty>
    </section>
  );
  const loading = (
    <div className="wb-loading" role="status">
      <LoaderCircle size={19} />
      正在加载…
    </div>
  );
  let content;
  if (!data.loaded) content = loading;
  else if (page === "home")
    content = (
      <Home data={data} user={user} inbox={inbox} onLaunch={openLaunch} />
    );
  else if (page === "teams" && !id)
    content = <TeamsPage data={data} user={user} />;
  else if (page === "teams" && (id === "new" || sub === "edit"))
    content =
      isOwner && (id === "new" || activeTeam) ? (
        <>
          <Alert message={dError} onRetry={reloadDiscovery} />
          <TeamEditor
            key={id}
            team={id === "new" ? null : activeTeam}
            user={user}
            members={data.members}
            discovery={discovery}
            onDiscover={reloadDiscovery}
            onSave={handleSave}
            onCancel={() => navigate("teams", ...(id === "new" ? [] : [id]))}
          />
        </>
      ) : (
        noAccess
      );
  else if (page === "teams" && activeTeam)
    content = (
      <TeamDetail
        team={activeTeam}
        data={data}
        user={user}
        onLaunch={openLaunch}
      />
    );
  else if (page === "runs" && !id)
    content = <RunsPage data={data} onLaunch={openLaunch} />;
  else if (page === "runs" && id) {
    const run = detail.item,
      role = run?.roles.find((r) => r.id === roleId);
    content =
      detail.error && !run ? (
        <section className="wb-page">
          <Alert
            message={detail.error}
            onRetry={() => detail.refresh().catch(() => {})}
          />
          <a href={href("runs")} className="wb-link">
            返回运行记录
          </a>
        </section>
      ) : !run ? (
        loading
      ) : sub === "roles" && role ? (
        <RoleSession
          key={`${run.id}-${role.id}`}
          user={user}
          run={run}
          role={role}
          refreshRun={refreshRun}
          onBack={() => navigate("runs", id)}
        />
      ) : sub ? (
        noAccess
      ) : (
        <RunPage run={run} members={data.members} />
      );
  } else if (page === "inbox") content = <InboxPage entries={inbox} />;
  else if (page === "environment" && isOwner)
    content = (
      <EnvironmentPage
        discovery={discovery}
        loading={detecting}
        error={dError}
        refresh={reloadDiscovery}
      />
    );
  else if (page === "members")
    content = <MembersPage user={user} members={data.members} />;
  else content = noAccess;
  return (
    <div className={`wb-app ${mobile ? "wb-nav-open" : ""}`}>
      <aside className="wb-sidebar">
        <a className="wb-brand" href={href("home")}>
          <span>
            <Workflow size={22} />
          </span>
          ohoo
        </a>
        <div className="wb-workspace">
          <span>本机协作空间</span>
          <small>Local workspace</small>
        </div>
        <nav className="wb-nav" aria-label="工作区导航">
          {sections
            .filter(([key]) => isOwner || key !== "environment")
            .map(([key, label, Icon]) => (
              <a
                key={key}
                className={page === key ? "wb-is-active" : ""}
                href={href(key)}
              >
                <Icon size={17} />
                {label}
                {key === "inbox" && inbox.length > 0 && <i>{inbox.length}</i>}
              </a>
            ))}
        </nav>
        <div className="wb-account">
          <span className="wb-avatar">{user.name.slice(0, 1)}</span>
          <div>
            <strong>{user.name}</strong>
            <small>{isOwner ? "本机管理员" : "成员"}</small>
          </div>
          <button
            type="button"
            aria-label="退出登录"
            title="退出登录"
            onClick={onLogout}
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      {mobile && (
        <button
          type="button"
          className="wb-nav-shade"
          aria-label="关闭导航"
          onClick={() => setMobile(false)}
        />
      )}
      <div className="wb-shell">
        <header className="wb-topbar">
          <button
            type="button"
            className="wb-nav-toggle"
            aria-label="打开导航"
            onClick={() => setMobile((x) => !x)}
          >
            <Menu size={18} />
          </button>
          <span>本机空间</span>
          <ChevronRight size={12} />
          <strong>{section?.[1] || "工作台"}</strong>
          {id && (
            <>
              <ChevronRight size={12} />
              <span>
                {page === "teams"
                  ? id === "new"
                    ? "创建团队"
                    : activeTeam?.name || "团队"
                  : detail.item?.title || "运行详情"}
              </span>
            </>
          )}
        </header>
        <main className="wb-content">
          <Alert
            message={data.error}
            onRetry={() => data.refresh().catch(() => {})}
          />
          {content}
        </main>
      </div>
      {launch && (
        <LaunchDialog
          teams={data.teams}
          initial={launch.id}
          onClose={() => setLaunch(null)}
          onDone={launchDone}
        />
      )}
    </div>
  );
}
