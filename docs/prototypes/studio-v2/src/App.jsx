import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Cloud,
  FileText,
  FolderOpen,
  GitBranch,
  Inbox,
  Layers3,
  LayoutDashboard,
  Monitor,
  Network,
  PanelLeft,
  Plus,
  RotateCcw,
  Search,
  Server,
  Settings2,
  SquareTerminal,
  UserRound,
  Workflow,
} from "lucide-react";
import {
  StudioProvider,
  useStudio,
  Button,
  IconButton,
  Modal,
  Field,
  Badge,
} from "./studio";
import { Teams } from "./Teams";
import { Runs } from "./Runs";
import { Session } from "./Session";
import { Admin } from "./Admin";
import "./global.css";

const navItems = [
  ["home", "工作台", LayoutDashboard],
  ["teams", "团队", Network],
  ["runs", "运行", Activity],
  ["inbox", "待办", Inbox],
  ["artifacts", "产物", FolderOpen],
  ["env", "执行环境", Monitor],
];
const pageTitles = {
  home: "工作台",
  teams: "团队",
  canvas: "团队编排",
  run: "运行详情",
  runs: "全部运行",
  session: "角色会话",
  inbox: "待我处理",
  artifacts: "产物档案",
  env: "执行环境",
  settings: "工作区设置",
  onboard: "首次使用",
};
function allRuns(ws) {
  return ws.teams
    .filter((t) => t.members.includes("林澄"))
    .flatMap((t) =>
      t.runs.map((r) => ({ t, r, n: r.nodes.find((n) => n.id === r.current) })),
    );
}
function tasks(ws, user) {
  return allRuns(ws).filter(
    ({ r, n }) =>
      r.status !== "已完成" &&
      n?.owner === user &&
      (n.kind === "human" ||
        r.status === "等待人工" ||
        r.artifacts.some((a) => a.toId === n.id && a.status === "待签收")),
  );
}
function goTask(nav, { t, r, n }) {
  nav(r.template === "delivery" ? "run" : "session", {
    teamId: t.id,
    runId: r.id,
    nodeId: n.id,
    tab: "action",
  });
}
function Mark() {
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      width="38"
      height="38"
      aria-hidden="true"
    >
      <path d="M20 2 37 12v16L20 38 3 28V12Z" fill="currentColor" />
      <path d="m9 16 6-3 10 6 6-3v8l-6 3-10-6-6 3z" fill="#18242a" />
    </svg>
  );
}
function PageHeading({ title, subtitle, children }) {
  return (
    <header className="s-heading">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <div className="heading-actions">{children}</div>
    </header>
  );
}
function TaskLine({ item, onOpen }) {
  const { r, n } = item,
    a = r.artifacts.findLast((x) => x.toId === n.id && x.status === "待签收");
  return (
    <button className="task-line" onClick={onOpen}>
      <span
        className={"task-type " + (r.template === "delivery" ? "dev" : "edit")}
      >
        {r.template === "delivery" ? (
          <GitBranch size={17} />
        ) : (
          <FileText size={17} />
        )}
      </span>
      <span className="line-grow">
        <strong>{a?.title || n.name}</strong>
        <small>
          {r.id} <i /> {n.name} {a && "· v" + a.rev}
        </small>
      </span>
      <ChevronRight size={15} />
    </button>
  );
}
function Featured({ item }) {
  const { nav } = useStudio();
  const { t, r, n } = item;
  const seen = new Set(r.history.map((e) => e.nodeId));
  const visual =
    r.template === "delivery"
      ? [
          "intake",
          "dev",
          "lead",
          ...(seen.has("peer") ? ["peer"] : []),
          "impl",
          "qa",
          "sre",
          "sign",
        ]
          .map((x) => r.nodes.find((n) => n.id === x))
          .filter(Boolean)
      : r.nodes;
  const current = Math.max(
    0,
    visual.findIndex((x) => x.id === r.current),
  );
  return (
    <article className="featured">
      <div className="featured-meta">
        <span className="run-code">
          <i />
          {r.id}
        </span>
        <span className="hero-meta-sep">/</span>
        <span>{t.name}</span>
        <span className="version-tag">v{r.version}</span>
      </div>
      <h2>{r.title}</h2>
      <p className="feature-next">
        <span className="pulse-dot" />{" "}
        {r.status === "已完成"
          ? "已完成"
          : r.status === "等待人工"
            ? "等待 " + n.owner + " · " + n.name
            : (n?.name || "角色") + " 正在处理工作"}
      </p>
      <div className="feature-pipeline" aria-label="运行阶段">
        {visual.map((x, i) => (
          <button
            key={x.id}
            title={x.name}
            onClick={() =>
              nav(
                x.id === r.current && r.status === "等待人工"
                  ? "run"
                  : "session",
                { teamId: t.id, runId: r.id, nodeId: x.id },
              )
            }
            className={i === current ? "here" : seen.has(x.id) ? "past" : ""}
          >
            <span>
              {i !== current && seen.has(x.id) ? (
                <Check size={14} />
              ) : x.kind === "human" ? (
                <UserRound size={15} />
              ) : (
                <SquareTerminal size={15} />
              )}
            </span>
            <small>{x.name}</small>
          </button>
        ))}
      </div>
      <footer>
        <span>
          <GitBranch size={14} /> {r.artifacts.length} 份交付记录
        </span>
        <button onClick={() => goTask(nav, { t, r, n })}>
          {n?.id === "lead"
            ? "审阅设计"
            : r.status === "等待人工"
              ? "处理待办"
              : "打开当前工作"}{" "}
          <ArrowUpRight size={16} />
        </button>
      </footer>
    </article>
  );
}
function Home() {
  const { ws, user, nav, launch } = useStudio();
  const all = allRuns(ws),
    live = all.filter((x) => x.r.status !== "已完成"),
    queue = tasks(ws, user),
    featured = live.find((x) => x.r.template === "delivery") || live[0];
  const [start, setStart] = useState(false),
    [filter, setFilter] = useState("全部");
  const env = ws.envs.find((x) => x.owner === user);
  return (
    <div className="page home-page">
      <PageHeading
        title="工作台"
        subtitle={
          live.length
            ? `${live.length} 项工作尚未结束，${queue.length} 项等待你处理。`
            : "从团队和执行环境开始配置工作区。"
        }
      >
        <Button
          variant="primary"
          onClick={() => (start ? setStart(false) : setStart(true))}
        >
          <Plus size={16} />
          发起工作
        </Button>
      </PageHeading>
      {start && (
        <Modal title="选择已发布的团队" onClose={() => setStart(false)}>
          {ws.teams
            .filter((t) => t.published)
            .map((t) => (
              <button
                className="choice-row"
                key={t.id}
                onClick={() => {
                  setStart(false);
                  launch(t.id);
                }}
              >
                <Network />
                <span>
                  <b>{t.name}</b>
                  <small>
                    流程 v{t.version} · {t.nodes.length} 个角色
                  </small>
                </span>
                <ArrowRight />
              </button>
            ))}
          {!ws.teams.some((t) => t.published) && (
            <div className="empty">
              <p>尚无已发布流程。</p>
              <Button
                onClick={() => {
                  setStart(false);
                  nav("teams", { tab: "new" });
                }}
              >
                创建团队
              </Button>
            </div>
          )}
        </Modal>
      )}
      <div className="home-grid">
        {featured ? (
          <Featured item={featured} />
        ) : (
          <div className="featured home-empty">
            <Workflow />
            <h2>发起第一项工作</h2>
            <p>创建团队，选择角色，发布第一版流程。</p>
            <Button onClick={() => nav("teams", { tab: "new" })}>
              创建团队 <ArrowRight size={16} />
            </Button>
          </div>
        )}
        <section className="desk-panel task-panel">
          <header>
            <div className="pane-title">
              <Inbox size={18} />
              <h2>待我处理</h2>
              <span className="small-count">{queue.length}</span>
            </div>
            <IconButton label="查看全部待办" onClick={() => nav("inbox")}>
              <ArrowUpRight size={17} />
            </IconButton>
          </header>
          <div>
            {queue.slice(0, 3).map((x) => (
              <TaskLine key={x.r.id} item={x} onOpen={() => goTask(nav, x)} />
            ))}
            {!queue.length && <p className="empty">当前没有待你处理的事项。</p>}
          </div>
          <button className="desk-device" onClick={() => nav("env")}>
            <Monitor size={17} />
            <span>
              <small>个人执行环境</small>
              <b>{env?.name || "连接第一台设备"}</b>
            </span>
            <span
              className={"device-dot " + (env?.status === "在线" ? "on" : "")}
            />
            <ChevronRight size={15} />
          </button>
        </section>
      </div>
      <section className="home-records">
        <header className="sub-head">
          <h2>工作记录</h2>
          <button
            className="quiet-link"
            onClick={() =>
              nav("runs", { teamId: null, runId: null, nodeId: null })
            }
          >
            所有运行 <ArrowRight size={14} />
          </button>
        </header>
        <div className="filter-strip">
          {["全部", "等待人工", "进行中", "已完成"].map((f) => (
            <button
              className={f === filter ? "chosen" : ""}
              key={f}
              onClick={() => setFilter(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="record-table">
          <div className="record-label">
            <span>委托 / 运行</span>
            <span>所属团队</span>
            <span>当前环节</span>
            <span>状态</span>
            <span />
          </div>
          {all
            .filter((x) => filter === "全部" || x.r.status === filter)
            .map(({ t, r, n }) => (
              <button
                className="record-row"
                key={t.id + r.id}
                onClick={() =>
                  nav("run", { teamId: t.id, runId: r.id, nodeId: r.current })
                }
              >
                <span className="record-main">
                  <span className="record-icon">
                    {r.template === "delivery" ? (
                      <GitBranch size={17} />
                    ) : (
                      <FileText size={17} />
                    )}
                  </span>
                  <span>
                    <b>{r.title}</b>
                    <small>
                      {r.id} <i /> v{r.version}
                    </small>
                  </span>
                </span>
                <span>{t.name}</span>
                <span>{n?.name || "—"}</span>
                <span>
                  <Badge
                    tone={
                      r.status === "等待人工"
                        ? "amber"
                        : r.status === "已完成"
                          ? "green"
                          : "blue"
                    }
                  >
                    {r.status}
                  </Badge>
                </span>
                <ArrowRight size={15} />
              </button>
            ))}
          {!all.some((x) => filter === "全部" || x.r.status === filter) && (
            <p className="empty">没有符合条件的运行。</p>
          )}
        </div>
      </section>
      <header className="sub-head lower">
        <h2>我的团队</h2>
        <button className="quiet-link" onClick={() => nav("teams")}>
          团队目录 <ArrowRight size={14} />
        </button>
      </header>
      <div className="home-teams">
        {ws.teams.map((t) => (
          <button
            className="home-team"
            key={t.id}
            onClick={() =>
              nav("canvas", { teamId: t.id, runId: null, nodeId: null })
            }
          >
            <span className="tilemark">
              {t.template === "delivery" ? (
                <Workflow size={20} />
              ) : (
                <Layers3 size={20} />
              )}
            </span>
            <span>
              <b>{t.name}</b>
              <small>
                {t.nodes.length} 个角色 ·{" "}
                {t.published ? "已发布 v" + t.version : "草稿"}
              </small>
            </span>
            <ArrowUpRight size={16} />
          </button>
        ))}
        <button
          className="create-team-link"
          onClick={() => nav("teams", { tab: "new" })}
        >
          <Plus size={19} />
          创建团队
        </button>
      </div>
    </div>
  );
}
function InboxPage() {
  const { ws, user, nav } = useStudio(),
    queue = tasks(ws, user);
  return (
    <div className="page">
      <PageHeading
        title="待我处理"
        subtitle={`${user} · ${queue.length} 项待决定或待签收`}
      />
      <section className="desk-panel inbox-list">
        <header className="pane-title">
          <ClipboardCheck size={18} />
          <h2>等待我的工作</h2>
        </header>
        {queue.map((x) => (
          <TaskLine key={x.r.id} item={x} onOpen={() => goTask(nav, x)} />
        ))}
        {!queue.length && <p className="empty">待办已处理完毕。</p>}
      </section>
    </div>
  );
}
function Archives() {
  const { ws, user, nav } = useStudio();
  const [term, setTerm] = useState(""),
    [filter, setFilter] = useState("当前版本"),
    [selected, setSelected] = useState(null);
  const rows = allRuns(ws).flatMap(({ r, t }) =>
    r.artifacts
      .filter((a) =>
        r.nodes.some(
          (n) => (n.id === a.nodeId || n.id === a.toId) && n.owner === user,
        ),
      )
      .map((a) => ({ r, t, a })),
  );
  const visible = rows.filter(
    (x) =>
      (filter === "含历史版本" ||
        !rows.some(
          (o) => o.r.id === x.r.id && o.a.id === x.a.id && o.a.rev > x.a.rev,
        )) &&
      (x.a.title + x.r.id + x.t.name)
        .toLowerCase()
        .includes(term.toLowerCase()),
  );
  const picked =
    selected &&
    rows.find(
      (x) =>
        x.r.id === selected.rid &&
        x.a.id === selected.id &&
        x.a.rev === selected.rev,
    );
  return (
    <div className="page">
      <PageHeading
        title="产物档案"
        subtitle="查看显式交付的版本、字段和签收记录。"
      />
      <div className="archive-tools">
        <label className="search-field">
          <Search size={16} />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="按产物、团队或运行号搜索"
          />
        </label>
        <select
          aria-label="版本范围"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option>当前版本</option>
          <option>含历史版本</option>
        </select>
      </div>
      <section className="desk-panel">
        {visible.map(({ r, t, a }) => (
          <button
            className="choice-row"
            key={r.id + a.id + a.rev}
            onClick={() => setSelected({ rid: r.id, id: a.id, rev: a.rev })}
          >
            <FileText />
            <span>
              <b>
                {a.title} <em>v{a.rev}</em>
              </b>
              <small>
                {t.name} / {r.id} · {a.actor || user}
              </small>
            </span>
            <Badge
              tone={
                a.status === "已签收"
                  ? "green"
                  : a.status === "已退回"
                    ? "red"
                    : "amber"
              }
            >
              {a.status}
            </Badge>
            <ChevronRight size={15} />
          </button>
        ))}
        {!visible.length && <p className="empty">没有匹配的已交付产物。</p>}
      </section>
      {picked && (
        <Modal
          title={picked.a.title + " · v" + picked.a.rev}
          onClose={() => setSelected(null)}
        >
          <Badge tone="blue">{picked.a.status}</Badge>
          <h3 className="form-title">提交内容</h3>
          <p className="prose">{picked.a.body}</p>
          {Object.entries(picked.a.fields || {}).map(([k, v]) => (
            <div key={k}>
              <h3 className="form-title">{k}</h3>
              <p className="prose">{v}</p>
            </div>
          ))}
          <h3 className="form-title">交接摘要</h3>
          <p className="prose">{picked.a.summary}</p>
          {picked.a.feedback && (
            <p className="form-help">退回意见 · {picked.a.feedback}</p>
          )}
          <div className="dialog-actions">
            <Button
              onClick={() =>
                nav("run", { teamId: picked.t.id, runId: picked.r.id })
              }
            >
              查看来源运行 <ArrowRight size={14} />
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function App() {
  const { db, ws, team, run, route, user, nav, switchWs, reset } = useStudio();
  const [menu, setMenu] = useState(false),
    [spaces, setSpaces] = useState(false),
    [search, setSearch] = useState(false),
    [query, setQuery] = useState(""),
    [resetOpen, setReset] = useState(false);
  useEffect(() => {
    setMenu(false);
    setSearch(false);
    setSpaces(false);
  }, [route, ws.id]);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setQuery("");
        setSearch((p) => !p);
      }
      if (e.key === "Escape") setMenu(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [small, setSmall] = useState(
    () => matchMedia("(max-width:620px)").matches,
  );
  useEffect(() => {
    const m = matchMedia("(max-width:620px)");
    const onResize = () => {
      setSmall(m.matches);
      setMenu(false);
    };
    m.addEventListener("change", onResize);
    return () => m.removeEventListener("change", onResize);
  }, []);
  const group =
    { canvas: "teams", run: "runs", session: "runs", onboard: "settings" }[
      route.page
    ] || route.page;
  const all = allRuns(ws),
    matches = all.filter((x) =>
      (x.t.name + x.r.title + x.r.id)
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
  const renderPage = () => {
    switch (route.page) {
      case "teams":
      case "canvas":
        return <Teams />;
      case "run":
      case "runs":
        return <Runs />;
      case "session":
        return <Session />;
      case "env":
      case "settings":
      case "onboard":
        return <Admin />;
      case "artifacts":
        return <Archives />;
      case "inbox":
        return <InboxPage />;
      default:
        return <Home />;
    }
  };
  const pick = (id) => {
    switchWs(id);
    setSpaces(false);
  };
  return (
    <div className={"layout " + (menu ? "navigation-open" : "")}>
      <button
        className="nav-scrim"
        aria-label="关闭导航"
        onClick={() => setMenu(false)}
      />
      <aside className="rail" inert={small && !menu}>
        <button
          className="brand"
          onClick={() => nav("home")}
          aria-label="ohoo 工作台"
        >
          <Mark />
          <strong>ohoo</strong>
        </button>
        <div className="rail-nav">
          {navItems.map(([id, name, Icon]) => (
            <button
              key={id}
              className={group === id ? "selected" : ""}
              aria-current={group === id ? "page" : undefined}
              onClick={() =>
                nav(id, { teamId: null, runId: null, nodeId: null })
              }
            >
              <Icon size={21} />
              <span>{name}</span>
              {id === "inbox" && tasks(ws, user).length > 0 && <i />}
            </button>
          ))}
        </div>
        <div className="rail-bottom">
          <button
            className={group === "settings" ? "selected" : ""}
            onClick={() => nav("settings")}
          >
            <Settings2 size={21} />
            <span>设置</span>
          </button>
          <button
            title="快速开始"
            aria-label="快速开始"
            onClick={() => nav("onboard")}
          >
            <Workflow size={19} />
            <span>开始使用</span>
          </button>
        </div>
      </aside>
      <div className="main-col">
        <header className="bar">
          <IconButton
            label="导航"
            className="mobile-nav"
            onClick={() => setMenu((p) => !p)}
          >
            <PanelLeft size={20} />
          </IconButton>
          <button className="workspace-btn" onClick={() => setSpaces(true)}>
            <span className="workspace-icon">
              {ws.mode === "cloud" ? <Boxes size={17} /> : <Server size={17} />}
            </span>
            {ws.name}
            <ChevronDown size={14} />
          </button>
          <span className="bar-divider" />
          <div className="crumbs">
            {(route.page === "canvas" ||
              route.page === "run" ||
              route.page === "session") &&
              team && (
                <>
                  <button onClick={() => nav("canvas", { teamId: team.id })}>
                    {team.name}
                  </button>
                  <ChevronRight size={13} />
                </>
              )}
            {route.page === "session" && run && (
              <>
                <button onClick={() => nav("run")}>{run.id}</button>
                <ChevronRight size={13} />
              </>
            )}
            <strong>{pageTitles[route.page] || "工作台"}</strong>
          </div>
          <button
            className="search-open"
            onClick={() => {
              setQuery("");
              setSearch(true);
            }}
            aria-label="查找团队或运行"
          >
            <Search size={15} />
            <span>查找</span>
            <kbd>⌘ K</kbd>
          </button>
          <span className="demo-tag">
            <i />
            本地演示
          </span>
          <span className="avatar" title={user}>
            {user.slice(-1)}
          </span>
        </header>
        <main
          key={
            ws.id +
            ":" +
            route.page +
            ":" +
            (route.page === "session" ? route.runId + route.nodeId : "")
          }
        >
          {renderPage()}
        </main>
      </div>
      {spaces && (
        <Modal title="工作区" onClose={() => setSpaces(false)}>
          {["cloud", "self"].map((mode) => (
            <section key={mode} className="space-section">
              <h3>
                {mode === "cloud" ? "SaaS 托管" : "企业自部署"}{" "}
                {ws.mode !== mode ? "· 切换部署示例" : ""}
              </h3>
              {db.spaces
                .filter((s) => s.mode === mode)
                .map((s) => (
                  <button
                    className="choice-row"
                    key={s.id}
                    onClick={() => pick(s.id)}
                  >
                    {mode === "cloud" ? <Cloud /> : <Server />}
                    <span>
                      <b>{s.name}</b>
                      <small>{s.teams.length} 个团队</small>
                    </span>
                    {s.id === ws.id ? (
                      <Check size={17} />
                    ) : (
                      <ArrowRight size={16} />
                    )}
                  </button>
                ))}
            </section>
          ))}
          <div className="dialog-actions">
            <Button
              variant="ghost"
              onClick={() => {
                setSpaces(false);
                setReset(true);
              }}
            >
              <RotateCcw size={14} />
              重置演示
            </Button>
            <Button
              variant="primary"
              onClick={() => nav("onboard", { tab: "create" })}
            >
              创建工作区
            </Button>
          </div>
        </Modal>
      )}
      {resetOpen && (
        <Modal title="恢复初始演示数据？" onClose={() => setReset(false)}>
          <p>会清除本浏览器中对所有示例工作区所做的更改。</p>
          <div className="dialog-actions">
            <Button onClick={() => setReset(false)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                setReset(false);
                reset();
              }}
            >
              重置本地演示
            </Button>
          </div>
        </Modal>
      )}
      {search && (
        <Modal title="查找团队或运行" onClose={() => setSearch(false)}>
          <label className="search-field">
            <Search size={16} />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="输入团队名称、运行编号或委托"
            />
          </label>
          {ws.teams
            .filter((t) => t.name.includes(query))
            .map((t) => (
              <button
                className="choice-row"
                key={t.id}
                onClick={() => nav("canvas", { teamId: t.id, runId: null })}
              >
                <Network />
                <span>
                  <b>{t.name}</b>
                  <small>团队</small>
                </span>
                <ArrowRight />
              </button>
            ))}
          {matches.map(({ t, r }) => (
            <button
              className="choice-row"
              key={r.id}
              onClick={() =>
                nav("run", { teamId: t.id, runId: r.id, nodeId: r.current })
              }
            >
              <Activity />
              <span>
                <b>{r.title}</b>
                <small>{r.id}</small>
              </span>
              <ArrowRight />
            </button>
          ))}
          {!matches.length && !ws.teams.some((t) => t.name.includes(query)) && (
            <p className="empty">没有匹配结果。</p>
          )}
        </Modal>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")).render(
  <StudioProvider>
    <App />
  </StudioProvider>,
);
