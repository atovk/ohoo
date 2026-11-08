import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowRight, KeyRound, TerminalSquare } from "lucide-react";
import App from "./App";
import { api } from "./api";
import "./login.css";

function initialAccess() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.has("owner")) return { kind: "owner", token: params.get("owner") };
  if (params.has("invite"))
    return { kind: "invite", token: params.get("invite") };
  return null;
}
function Root() {
  const [access, setAccess] = useState(initialAccess),
    [user, setUser] = useState(null),
    [loading, setLoading] = useState(true);
  const [name, setName] = useState(""),
    [manual, setManual] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const clearToken = () => {
    history.replaceState(
      null,
      "",
      location.pathname + location.search + "#/home",
    );
    setAccess(null);
  };
  useEffect(() => {
    let live = true;
    async function start() {
      try {
        if (access?.kind === "owner") {
          const owner = await api("/login", {
            method: "POST",
            body: { token: access.token },
          });
          if (live) {
            clearToken();
            setUser(owner);
          }
        } else if (access?.kind !== "invite") {
          const current = await api("/me");
          if (live) setUser(current);
        }
      } catch (e) {
        if (live && e.status !== 401) setError(e.message);
      } finally {
        if (live) setLoading(false);
      }
    }
    start();
    const expired = () => {
      setUser(null);
      setError("登录已过期，请重新打开访问链接。");
    };
    window.addEventListener("ohoo:auth-expired", expired);
    return () => {
      live = false;
      window.removeEventListener("ohoo:auth-expired", expired);
    };
  }, []);
  async function login(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      let token = access?.token || manual.trim(),
        kind = access?.kind;
      if (token.includes("#")) {
        const fragment = new URLSearchParams(token.split("#").at(-1));
        kind = fragment.has("owner") ? "owner" : "invite";
        token = fragment.get(kind) || "";
      }
      const current = await api("/login", {
        method: "POST",
        body: { token, name: name.trim() },
      });
      clearToken();
      setManual("");
      setUser(current);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    try {
      await api("/logout", { method: "POST", body: {} });
      setUser(null);
      setError("");
      clearToken();
    } catch (e) {
      setError(e.message);
    }
  }
  if (user) return <App user={user} onLogout={logout} />;
  if (loading) return <main className="login-wrap">正在连接本地工作台…</main>;
  const invite = access?.kind === "invite";
  return (
    <main className="login-wrap">
      <section className="login-card">
        <header>
          <span className="login-brand">
            <TerminalSquare size={22} /> ohoo
          </span>
          <small>本地工作台</small>
        </header>
        <h1>{invite ? "加入团队工作区" : "打开本机工作区"}</h1>
        <p>
          {invite
            ? "请填写显示名称，使用这份一次性邀请加入。"
            : "在项目目录运行以下命令，可以用本机所有者身份打开工作台。"}
        </p>
        {!invite && <pre>npm run open</pre>}
        <form onSubmit={login}>
          {!access && (
            <label>
              访问密钥或邀请链接
              <input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                type="password"
                autoComplete="off"
                required
                placeholder="粘贴本机密钥或邀请链接"
              />
            </label>
          )}
          {(!access || invite) && (
            <label>
              成员显示名称{invite ? "" : "（仅加入邀请时填写）"}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required={invite}
                maxLength={100}
              />
            </label>
          )}
          {error && (
            <p role="alert" className="login-error">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy}>
            {busy ? "正在验证…" : invite ? "加入工作区" : "进入工作台"}
            <ArrowRight size={16} />
          </button>
        </form>
        <footer>
          <KeyRound size={14} />{" "}
          本机访问链接代表所有者权限，请仅在本人浏览器中使用。
        </footer>
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")).render(<Root />);
