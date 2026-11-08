import React, { useState } from "react";
import {
  ArrowRight,
  Cloud,
  Laptop,
  Monitor,
  Plug,
  Plus,
  RefreshCw,
  Server,
  Terminal,
  UserPlus,
  Users,
} from "lucide-react";
import { useStudio, uid, clone, Button, Modal, Field, Badge } from "./studio";
import "./admin.css";

const candidates = [
  { name: "Claude Code", status: "已发现", models: ["默认模型（模拟）"] },
  { name: "Codex", status: "已发现", models: ["默认模型（模拟）"] },
  { name: "pi", status: "需登录", models: ["默认模型（模拟）"] },
];
const tone = (s) =>
  ({
    在线: "green",
    已验证: "green",
    已发现: "blue",
    需登录: "amber",
    已加入: "green",
    待接受: "amber",
  })[s] || "neutral";
const kindName = (e) => (e.kind === "remote" ? "远端主机" : "本机工作环境");
const isAllowed = (ws, e) => e.kind !== "remote" || ws.allowRemote;
const fmtTime = (t) =>
  t
    ? new Date(t).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "尚未记录时间";
function Status({ value }) {
  return <Badge tone={tone(value)}>{value}</Badge>;
}
function Head({ title, description, children }) {
  return (
    <header className="ad-head">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children}
    </header>
  );
}
function Actions({ onClose, label, disabled = false }) {
  return (
    <div className="ad-modal-actions">
      <Button type="button" variant="ghost" onClick={onClose}>
        取消
      </Button>
      <Button type="submit" variant="primary" disabled={disabled}>
        {label}
      </Button>
    </div>
  );
}

function Pair({ ws, user, onClose, onPair }) {
  const [kind, setKind] = useState("local");
  const [name, setName] = useState(user + "的工作机");
  const [error, setError] = useState("");
  const [code] = useState(() =>
    String(Math.floor(100000 + Math.random() * 900000)),
  );
  function submit(e) {
    e.preventDefault();
    const value = name.trim();
    if (!value) {
      setError("请填写设备名称。");
      return;
    }
    if (ws.envs.some((item) => item.owner === user && item.name === value)) {
      setError("已有同名设备，请使用另一个名称。");
      return;
    }
    if (kind === "remote" && !ws.allowRemote) {
      setError("此工作区尚未开放远端主机。");
      return;
    }
    onPair({
      id: uid(),
      name: value,
      owner: user,
      status: "在线",
      kind,
      providers: [],
    });
  }
  return (
    <Modal title="连接个人设备" onClose={onClose}>
      <form className="ad-modal" onSubmit={submit}>
        <p className="ad-modal-info">
          这次配对归属于{ws.name}的{user}。浏览器仅模拟登记设备。
        </p>
        <Field label="设备类型">
          <select
            value={kind}
            onChange={(e) => {
              const v = e.target.value;
              setKind(v);
              setError("");
              if ([user + "的工作机", user + "的远端主机"].includes(name))
                setName(user + (v === "remote" ? "的远端主机" : "的工作机"));
            }}
          >
            <option value="local">本机工作环境</option>
            <option value="remote" disabled={!ws.allowRemote}>
              远端主机{ws.allowRemote ? " · 个人系统账号" : " · 工作区未开放"}
            </option>
          </select>
        </Field>
        <Field label="设备名称">
          <input
            autoFocus
            maxLength="60"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
            required
          />
        </Field>
        <div className="ad-code">
          <small>演示配对码</small>
          <strong>
            {code.slice(0, 3)} {code.slice(3)}
          </strong>
        </div>
        {error && (
          <p className="ad-error" role="alert">
            {error}
          </p>
        )}
        <Actions onClose={onClose} label="完成模拟配对" />
      </form>
    </Modal>
  );
}

function Trial({ env, provider, onClose, onRun }) {
  const [model, setModel] = useState(
    provider.models?.[0] || "默认模型（模拟）",
  );
  return (
    <Modal title="执行器试跑" onClose={onClose}>
      <form
        className="ad-modal"
        onSubmit={(e) => {
          e.preventDefault();
          onRun(model);
        }}
      >
        <p className="ad-modal-info">
          以{env.owner}的身份，在{env.name}上模拟验证 {provider.name}。
        </p>
        {provider.status === "需登录" && (
          <div className="ad-note">
            示例报告了鉴权失败。真实使用时，需本人在所选执行机登录，再重新试跑。
          </div>
        )}
        <Field label="试跑模型">
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {(provider.models?.length
              ? provider.models
              : ["默认模型（模拟）"]
            ).map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
        <div className="ad-sample">
          <small>试跑样例</small>
          <p>返回工作目录名称。</p>
        </div>
        <p className="ad-modal-info">
          只更新本地示例的验证状态，不会调用 daemon、模型或个人凭据。
        </p>
        <Actions
          onClose={onClose}
          label={
            provider.status === "需登录" ? "模拟登录并重试" : "开始模拟试跑"
          }
        />
      </form>
    </Modal>
  );
}

function Environment() {
  const { ws, user, updateWs, toast } = useStudio();
  const mine = ws.envs.filter((e) => e.owner === user);
  const others = ws.envs.filter((e) => e.owner !== user);
  const [selected, setSelected] = useState("");
  const [pair, setPair] = useState(false);
  const [trial, setTrial] = useState(null);
  const env = mine.find((e) => e.id === selected) || mine[0];
  const provider = env?.providers.find((p) => p.name === trial);
  const online = env?.status === "在线" && isAllowed(ws, env);
  function changeOwn(fn) {
    if (!env) return;
    updateWs((w) => {
      const device = w.envs.find((e) => e.id === env.id && e.owner === user);
      if (device) fn(device, w);
    });
  }
  function scan() {
    if (!online) return;
    changeOwn((device, w) => {
      if (device.status !== "在线" || !isAllowed(w, device)) return;
      candidates.forEach((c) => {
        const found = device.providers.find(
          (p) => p.name.toLowerCase() === c.name.toLowerCase(),
        );
        if (found) {
          if (!found.models?.length) found.models = clone(c.models);
        } else device.providers.push(clone(c));
      });
      device.lastScan = Date.now();
    });
    toast("已刷新本设备的模拟发现结果");
  }
  function connect() {
    if (!env || !isAllowed(ws, env)) return;
    const next = env.status === "在线" ? "离线" : "在线";
    changeOwn((e) => {
      e.status = next;
    });
    toast(next === "在线" ? "设备已模拟重连" : "已模拟离线，检测记录已保留");
  }
  return (
    <div className="studio-admin">
      <Head
        title="执行环境"
        description={`查看你在${ws.name}登记的设备、执行器与模型。`}
      >
        <Button variant="primary" onClick={() => setPair(true)}>
          <Plus size={16} />
          连接设备
        </Button>
      </Head>
      {env ? (
        <div className="ad-device-grid">
          <aside className="ad-device-index">
            <div className="ad-index-title">
              我的设备 <span>{mine.length}</span>
            </div>
            {mine.map((d) => (
              <button
                type="button"
                className="ad-env-choice"
                key={d.id}
                aria-pressed={d.id === env.id}
                onClick={() => {
                  setSelected(d.id);
                  setTrial(null);
                }}
              >
                <b>{d.name}</b>
                <small>
                  {kindName(d)} · {d.status}
                </small>
              </button>
            ))}
          </aside>
          <section className="ad-device-body">
            <header className="ad-device-heading">
              <div className="ad-env-meta">
                {env.kind === "remote" ? (
                  <Server size={14} />
                ) : (
                  <Laptop size={14} />
                )}{" "}
                {kindName(env)} / {env.owner}
              </div>
              <div className="ad-env-line">
                <h2>{env.name}</h2>
                <Status value={env.status} />
              </div>
              <p>
                此设备的执行账号归{env.owner}
                使用。下方为原型模拟的发现与验证结果。
              </p>
            </header>
            {!isAllowed(ws, env) ? (
              <div className="ad-note">
                当前工作区暂停了远端执行。管理员可在设置中调整接入策略。
              </div>
            ) : (
              !online && (
                <div className="ad-note">
                  设备已离线。目录保留上次发现结果，重连后可再次检测或试跑。
                </div>
              )
            )}
            <div className="ad-tools">
              <div className="ad-tools-header">
                <div>
                  <h3>执行器目录</h3>
                  <small>
                    {online ? "最近检测" : "缓存检测"} · {fmtTime(env.lastScan)}
                  </small>
                </div>
                <Button disabled={!online} onClick={scan}>
                  <RefreshCw size={14} />
                  {env.providers.length ? "重新检测" : "模拟发现 CLI"}
                </Button>
              </div>
              {env.providers.length ? (
                <table className="ad-tool-table">
                  <thead>
                    <tr>
                      <th>执行器 / 模型</th>
                      <th>验证状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {env.providers.map((p) => (
                      <tr key={p.name}>
                        <td>
                          <strong>
                            <Terminal size={15} />
                            {p.name}
                          </strong>
                          <small>
                            {p.models?.length
                              ? p.models.join(" · ")
                              : "模型尚未检测"}
                          </small>
                        </td>
                        <td>
                          <Status value={p.status} />
                          {p.lastTest && (
                            <small>试跑于 {fmtTime(p.lastTest)}</small>
                          )}
                        </td>
                        <td>
                          <button
                            disabled={!online}
                            type="button"
                            className="ad-link"
                            onClick={() => setTrial(p.name)}
                          >
                            {p.status === "需登录"
                              ? "处理登录"
                              : p.status === "已验证"
                                ? "重新试跑"
                                : "试跑验证"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="ad-hint">
                  尚无发现记录。选择「模拟发现 CLI」列出这台设备的候选执行器。
                </p>
              )}
            </div>
            <footer className="ad-device-foot">
              <span>设备连接</span>
              <Button disabled={!isAllowed(ws, env)} onClick={connect}>
                <Plug size={14} />
                {env.status === "在线" ? "模拟离线" : "模拟重连"}
              </Button>
            </footer>
          </section>
        </div>
      ) : (
        <div className="ad-empty">
          <Monitor size={29} />
          <h2>连接你的第一台工作机</h2>
          <p>配对后可列出执行器并试跑。团队与角色草稿也可以先建立。</p>
          <Button onClick={() => setPair(true)}>
            配对工作机 <ArrowRight size={15} />
          </Button>
        </div>
      )}
      {!!others.length && (
        <section className="ad-section ad-others">
          <header className="ad-section-head">
            <div>
              <h2>其他成员的设备</h2>
              <p>仅显示本工作区内的设备归属和状态。</p>
            </div>
          </header>
          {others.map((d) => (
            <div className="ad-compact-row" key={d.id}>
              <strong>{d.name}</strong>
              <span>{d.owner}</span>
              <span>
                <Status value={d.status} />
              </span>
            </div>
          ))}
        </section>
      )}
      {pair && (
        <Pair
          ws={ws}
          user={user}
          onClose={() => setPair(false)}
          onPair={(device) => {
            updateWs((w) => {
              w.envs.push(device);
            });
            setSelected(device.id);
            setPair(false);
            toast("模拟配对完成");
          }}
        />
      )}
      {provider && (
        <Trial
          key={env.id + provider.name}
          env={env}
          provider={provider}
          onClose={() => setTrial(null)}
          onRun={(model) => {
            if (!online) return;
            changeOwn((d, w) => {
              if (d.status !== "在线" || !isAllowed(w, d)) return;
              const found = d.providers.find((p) => p.name === provider.name);
              if (found) {
                found.status = "已验证";
                if (!found.models?.length) found.models = [model];
                found.lastTest = Date.now();
                found.lastModel = model;
              }
            });
            setTrial(null);
            toast(`${provider.name} 模拟试跑通过`);
          }}
        />
      )}
    </div>
  );
}

function Invite({ ws, onClose, onInvite }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  return (
    <Modal title="邀请工作区成员" onClose={onClose}>
      <form
        className="ad-modal"
        onSubmit={(e) => {
          e.preventDefault();
          const person = name.trim();
          if (!person) {
            setError("请输入新成员的姓名。");
            return;
          }
          if (
            ws.members.includes(person) ||
            ws.invitations?.some((i) => i.name === person)
          ) {
            setError("此人已加入工作区或已有邀请。");
            return;
          }
          onInvite({ id: uid(), name: person });
        }}
      >
        <p className="ad-modal-info">
          在{ws.name}建立一条示例邀请。邀请保存在本地，不会发送消息。
        </p>
        <Field label="成员姓名">
          <input
            value={name}
            autoFocus
            required
            maxLength="32"
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
            placeholder="例如：周禾"
          />
        </Field>
        {error && (
          <p className="ad-error" role="alert">
            {error}
          </p>
        )}
        <Actions onClose={onClose} label="创建本地邀请" />
      </form>
    </Modal>
  );
}

function Settings() {
  const { ws, user, updateWs, toast, nav } = useStudio();
  const [name, setName] = useState(ws.name);
  const [addr, setAddr] = useState(ws.serviceAddress || "");
  const [remote, setRemote] = useState(!!ws.allowRemote);
  const [invite, setInvite] = useState(false);
  const [error, setError] = useState("");
  const self = ws.mode === "self";
  const invitations = ws.invitations || [];
  function save(e) {
    e.preventDefault();
    const title = name.trim();
    const url = addr.trim();
    if (!title) {
      setError("请填写工作区名称。");
      return;
    }
    if (self && url && !/^https?:\/\//i.test(url)) {
      setError("实例地址应以 https:// 或 http:// 开头。");
      return;
    }
    updateWs((w) => {
      w.name = title;
      w.allowRemote = remote;
      if (self) w.serviceAddress = url;
      if (!remote)
        w.envs
          .filter((e) => e.kind === "remote")
          .forEach((e) => {
            e.status = "离线";
          });
    });
    setError("");
    toast("设置已保存至当前工作区");
  }
  function accept(item) {
    updateWs((w) => {
      if (!w.invitations?.some((i) => i.id === item.id)) return;
      if (!w.members.includes(item.name)) w.members.push(item.name);
      w.invitations = w.invitations.filter((i) => i.id !== item.id);
    });
    toast(`${item.name} 已模拟接受本工作区邀请`);
  }
  return (
    <div className="studio-admin">
      <Head
        title="工作区设置"
        description={`${ws.name} · 以管理员 ${user} 的示例身份管理。`}
      >
        <Button variant="ghost" onClick={() => nav("onboard")}>
          切换部署示例 <ArrowRight size={14} />
        </Button>
      </Head>
      <form onSubmit={save}>
        <div className="ad-settings-group">
          <div>
            <h2>部署与工作区</h2>
            <p>当前示例属于独立的部署形态。</p>
          </div>
          <div className="ad-settings-body">
            <div className="ad-instance">
              {self ? <Server size={22} /> : <Cloud size={22} />}
              <div>
                <strong>{self ? "企业自部署" : "SaaS 托管"}</strong>
                <p>
                  {self
                    ? "由企业维护实例与服务接入地址。"
                    : "由平台维护管理服务，成员通过托管入口进入工作区。"}
                </p>
              </div>
            </div>
            <Field label="工作区名称">
              <input
                required
                value={name}
                maxLength="60"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            {self && (
              <Field label="企业实例地址">
                <input
                  type="url"
                  value={addr}
                  placeholder="https://ohoo.example.internal"
                  onChange={(e) => setAddr(e.target.value)}
                />
              </Field>
            )}
          </div>
        </div>
        <div className="ad-settings-group">
          <div>
            <h2>执行环境策略</h2>
            <p>
              {self
                ? "设定企业实例接受的可信主机类型。"
                : "设定本工作区允许成员配对的设备。"}
            </p>
          </div>
          <div className="ad-settings-body">
            <div className="ad-simple-row">
              <span>个人工作机</span>
              <strong>允许配对</strong>
            </div>
            <label className="ad-policy">
              <span>
                <strong>
                  {self ? "允许可信远端主机" : "允许个人远端主机"}
                </strong>
                <p>关闭后，已登记的远端设备将转为离线。</p>
              </span>
              <input
                type="checkbox"
                checked={remote}
                onChange={(e) => setRemote(e.target.checked)}
              />
            </label>
          </div>
        </div>
        {error && (
          <p className="ad-error" role="alert">
            {error}
          </p>
        )}
        <div className="ad-setting-footer">
          <span>
            {self ? "实例地址仅保存到本地演示。" : "设置仅在当前工作区生效。"}
          </span>
          <Button type="submit" variant="primary">
            保存设置
          </Button>
        </div>
      </form>
      <section className="ad-section">
        <div className="ad-section-head">
          <div>
            <h2>工作区成员</h2>
            <p>
              {ws.members.length} 位成员 · {invitations.length} 份待接受的邀请
            </p>
          </div>
          <Button onClick={() => setInvite(true)}>
            <UserPlus size={15} />
            邀请成员
          </Button>
        </div>
        {ws.members.map((m) => (
          <div className="ad-compact-row" key={m}>
            <strong>{m}</strong>
            <span>{m === user ? "当前管理员" : "成员"}</span>
            <span>
              <Status value="已加入" />
            </span>
          </div>
        ))}
        {invitations.map((i) => (
          <div className="ad-compact-row" key={i.id}>
            <strong>{i.name}</strong>
            <span>
              <Status value="待接受" />
            </span>
            <span className="ad-inv-actions">
              <button
                type="button"
                className="ad-link"
                onClick={() => accept(i)}
              >
                模拟接受
              </button>
              <button
                type="button"
                className="ad-link"
                onClick={() => {
                  updateWs((w) => {
                    w.invitations = w.invitations.filter((x) => x.id !== i.id);
                  });
                  toast("本地邀请已撤回");
                }}
              >
                撤回
              </button>
            </span>
          </div>
        ))}
      </section>
      {invite && (
        <Invite
          ws={ws}
          onClose={() => setInvite(false)}
          onInvite={(i) => {
            updateWs((w) => {
              (w.invitations ||= []).push(i);
            });
            setInvite(false);
            toast("已生成本地邀请");
          }}
        />
      )}
    </div>
  );
}

function Guide({ member }) {
  const { ws, user, nav, updateWs, toast } = useStudio();
  const invited = ws.invitations?.some((i) => i.name === user);
  const joined = ws.members.includes(user);
  const owns = ws.envs.some((e) => e.owner === user);
  return (
    <div className="studio-admin">
      <Head
        title={ws.name}
        description={`${ws.mode === "self" ? "企业自部署" : "SaaS 托管"} · ${user} · ${member ? "工作区成员" : "工作区负责人"}`}
      />
      <div className="ad-content ad-guide">
        <h2>{joined ? "开始在工作区协作" : "确认加入工作区"}</h2>
        {joined ? (
          <>
            <p>
              你可以先连接个人工作机，也可以先建立团队，保存尚未绑定执行器的角色草稿。
            </p>
            <div className="ad-guide-actions">
              <Button
                variant={owns ? "default" : "primary"}
                onClick={() => nav("env")}
              >
                <Laptop size={16} />
                {owns ? "查看个人设备" : "连接第一台工作机"}
              </Button>
              {member ? (
                <Button onClick={() => nav("teams")}>
                  <Users size={16} />
                  查看团队
                </Button>
              ) : (
                <Button onClick={() => nav("teams", { tab: "new" })}>
                  <Plus size={16} />
                  新建团队
                </Button>
              )}
              <Button variant="ghost" onClick={() => nav("home")}>
                进入工作台 <ArrowRight size={15} />
              </Button>
            </div>
          </>
        ) : invited ? (
          <>
            <p>
              {user} 有一份进入{ws.name}的模拟邀请。
            </p>
            <Button
              variant="primary"
              onClick={() => {
                updateWs((w) => {
                  if (!w.members.includes(user)) w.members.push(user);
                  w.invitations = (w.invitations || []).filter(
                    (i) => i.name !== user,
                  );
                });
                toast("已加入这个示例工作区");
              }}
            >
              接受邀请并加入
            </Button>
          </>
        ) : (
          <p>当前身份尚未取得此工作区的成员资格。</p>
        )}
      </div>
    </div>
  );
}

function Onboard() {
  const { ws, db, user, route, nav, createSpace, switchWs, toast } =
    useStudio();
  const [mode, setMode] = useState(ws.mode);
  const [operation, setOperation] = useState("enter");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  if (route.tab === "guide" || route.tab === "member")
    return <Guide member={route.tab === "member"} />;
  const spaces = db.spaces.filter(
    (w) =>
      w.mode === mode &&
      (w.members.includes(user) || w.invitations?.some((i) => i.name === user)),
  );
  const target = spaces.find((w) => w.id === selected) || spaces[0];
  function enter() {
    if (!target) return;
    switchWs(target.id);
    nav("onboard", { tab: "member" });
  }
  function create(e) {
    e.preventDefault();
    const title = name.trim();
    if (!title) {
      setError("请填写工作区名称。");
      return;
    }
    if (db.spaces.some((w) => w.mode === mode && w.name === title)) {
      setError("此部署已有同名工作区。");
      return;
    }
    createSpace({ name: title, mode });
    nav("onboard", { tab: "guide" });
    toast("已创建示例工作区");
  }
  return (
    <div className="studio-admin">
      <Head
        title="进入工作区"
        description="选择部署示例，再以你的身份进入已有工作区或创建新的工作区。"
      />
      <div className="ad-onboard-layout">
        <div className="ad-content ad-steps">
          <div>
            <h2>选择部署示例</h2>
            <p>以下为本地演示的两个独立入口。各自保存工作区、成员和设备。</p>
          </div>
          <div className="ad-choice-row">
            {[
              ["cloud", "SaaS 托管", "平台管理服务", Cloud],
              ["self", "企业自部署", "企业维护的独立实例", Server],
            ].map(([id, title, sub, Icon]) => (
              <button
                className="ad-choice"
                type="button"
                key={id}
                aria-pressed={mode === id}
                onClick={() => {
                  setMode(id);
                  setSelected("");
                  setError("");
                }}
              >
                <Icon size={20} />
                <span>
                  <b>{title}</b>
                  <small>{sub}</small>
                </span>
              </button>
            ))}
          </div>
          <div className="ad-ws-select">
            <div className="ad-segment">
              <button
                type="button"
                aria-pressed={operation === "enter"}
                onClick={() => {
                  setOperation("enter");
                  setError("");
                }}
              >
                成员进入
              </button>
              <button
                type="button"
                aria-pressed={operation === "create"}
                onClick={() => {
                  setOperation("create");
                  setError("");
                }}
              >
                负责人新建
              </button>
            </div>
            {operation === "enter" ? (
              <>
                <Field label="可进入的工作区">
                  <select
                    value={target?.id || ""}
                    onChange={(e) => setSelected(e.target.value)}
                    disabled={!spaces.length}
                  >
                    {!spaces.length && (
                      <option value="">暂无可加入的工作区</option>
                    )}
                    {spaces.map((w) => (
                      <option value={w.id} key={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <p>
                  {target
                    ? `将以 ${user} 的身份${target.members.includes(user) ? "进入" : "接受邀请加入"}所选工作区。`
                    : "需要此部署管理员的邀请才能加入。"}
                </p>
                <div>
                  <Button variant="primary" disabled={!target} onClick={enter}>
                    进入工作区 <ArrowRight size={15} />
                  </Button>
                </div>
              </>
            ) : (
              <form className="ad-create" onSubmit={create}>
                <Field label="工作区名称">
                  <input
                    value={name}
                    required
                    maxLength="60"
                    onChange={(e) => {
                      setName(e.target.value);
                      setError("");
                    }}
                    placeholder="例如：内容策划工作室"
                  />
                </Field>
                <p>{user}将作为新工作区的负责人。</p>
                {error && (
                  <p role="alert" className="ad-error">
                    {error}
                  </p>
                )}
                <div>
                  <Button type="submit" variant="primary">
                    创建工作区 <ArrowRight size={15} />
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
        <aside className="ad-next">
          <h2>进入之后</h2>
          <ol>
            <li>在执行环境中配对自己的设备，查看可用的 CLI 与模型。</li>
            <li>进入团队，按职责配置成员、角色和交接条件。</li>
          </ol>
        </aside>
      </div>
    </div>
  );
}

export function Admin() {
  const { ws, route } = useStudio();
  if (route.page === "onboard") return <Onboard key={ws.id} />;
  if (route.page === "settings") return <Settings key={ws.id} />;
  return <Environment key={ws.id} />;
}
