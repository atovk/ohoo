import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { cookieName, cookieAge } from "./auth.mjs";
import { StoreError } from "./store.mjs";
import { resolveWorkspace } from "./config.mjs";

const assets = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
};
const dist = new URL("../dist/", import.meta.url);
const deny = (status, code, message) => {
  throw new StoreError(status, code, message);
};
const cookie = (request) =>
  (request.headers.cookie || "")
    .split(/;\s*/)
    .find((v) => v.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
function json(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}
async function readJson(req) {
  if ((req.headers["content-type"] || "").split(";")[0] !== "application/json")
    deny(415, "json_required", "请提交 JSON 请求。");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024)
      deny(413, "too_large", "内容超过 1 MiB，请提交片段或文件引用。");
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    deny(400, "bad_json", "JSON 格式错误。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    deny(400, "bad_input", "请求必须是对象。");
  return value;
}

export function createHttpService({
  store,
  auth,
  execution,
  runtime,
  workspace,
  gate,
}) {
  // The store commits the handoff and its durable job together. Waking the
  // executor only reduces latency; recovery can rediscover the same job.
  function afterHandoff(run) {
    if (
      run.handoffJobs?.some(
        (job) => job.status === "queued" || job.status === "prepared",
      )
    ) {
      execution.wake();
    }
    return run;
  }
  return http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    try {
      const port = req.socket.localPort,
        host = req.headers.host;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)
        deny(403, "bad_host", "仅允许本机访问。");
      if (req.headers.origin && req.headers.origin !== `http://${host}`)
        deny(403, "bad_origin", "跨来源请求已拒绝。");
      const url = new URL(req.url, "http://" + host),
        p = url.pathname,
        m = req.method;
      if (!p.startsWith("/api/")) {
        if (m !== "GET" || !Object.hasOwn(assets, p))
          return json(res, 404, {
            error: "not_found",
            message: "页面不存在。",
          });
        const [file, type] = assets[p];
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        );
        const body = await readFile(fileURLToPath(new URL(file, dist)));
        res.writeHead(200, { "Content-Type": type });
        res.end(body);
        return;
      }
      if (m === "GET" && p === "/api/health")
        return json(res, 200, { service: "ohoo-local", ready: true });
      const actionRoute = p.match(
        /^\/api\/role-actions\/([a-zA-Z0-9-]{1,128})\/(test|deploy|verify)$/,
      );
      if (m === "POST" && actionRoute && gate) {
        await readJson(req);
        const token = /^Bearer ([0-9a-f]{64})$/.exec(
          req.headers.authorization || "",
        )?.[1];
        return json(
          res,
          200,
          await gate.invoke(actionRoute[1], actionRoute[2], token),
        );
      }
      if (m === "POST" && p === "/api/login") {
        const b = await readJson(req);
        if (
          typeof b.token !== "string" ||
          b.token.length > 300 ||
          !b.token.trim()
        )
          deny(400, "token_required", "请输入访问密钥或邀请。");
        const user = auth.matchesOwner(b.token)
          ? store.owner()
          : store.redeemInvite(b.token, { name: b.name });
        auth.revoke(cookie(req));
        const token = auth.issue(user.id);
        res.setHeader(
          "Set-Cookie",
          `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${cookieAge}`,
        );
        return json(res, 200, user);
      }
      const user = store.getUser(auth.userId(cookie(req)));
      if (!user) deny(401, "login_required", "请通过本机访问链接或邀请登录。");
      const actor = user.id;
      if (m === "GET" && p === "/api/me") return json(res, 200, user);
      if (m === "POST" && p === "/api/logout") {
        await readJson(req);
        auth.revoke(cookie(req));
        res.setHeader(
          "Set-Cookie",
          `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
        );
        return json(res, 200, { ok: true });
      }
      if (m === "GET" && p === "/api/members")
        return json(res, 200, store.listMembers(actor));
      if (m === "POST" && p === "/api/invites") {
        const invite = store.createInvite(actor, await readJson(req));
        return json(res, 201, {
          url: `http://${host}/#invite=${encodeURIComponent(invite.token)}`,
          expiresAt: invite.expiresAt,
        });
      }
      if (m === "GET" && p === "/api/providers") {
        if (user.role !== "owner")
          deny(403, "forbidden", "只有本机所有者可查询其执行环境。");
        let cwd;
        try {
          cwd = resolveWorkspace(workspace, url.searchParams.get("cwd"));
        } catch {
          deny(400, "bad_cwd", "无法访问指定工作目录。");
        }
        const environment = {
          id: "local",
          name: "本机 Paseo",
          cwd,
          root: workspace,
        };
        try {
          return json(res, 200, {
            online: true,
            environment,
            providers: await runtime.listProviders(cwd),
          });
        } catch (err) {
          return json(res, 200, {
            online: false,
            environment,
            providers: [],
            error: err.message,
          });
        }
      }
      if (m === "GET" && p === "/api/teams")
        return json(res, 200, store.listTeams(actor));
      async function teamBody() {
        if (user.role !== "owner")
          deny(403, "forbidden", "只有本机所有者可以配置团队。");
        const b = await readJson(req);
        if (Array.isArray(b.roles))
          for (const role of b.roles)
            if (role?.kind === "agent") {
              try {
                role.cwd = resolveWorkspace(workspace, role.cwd);
              } catch {
                deny(
                  400,
                  "bad_cwd",
                  "角色工作目录不存在或不在已配置的根目录内。",
                );
              }
            }
        return b;
      }
      if (m === "POST" && p === "/api/teams")
        return json(res, 201, store.createTeam(actor, await teamBody()));
      let parts;
      try {
        parts = p.split("/").filter(Boolean).map(decodeURIComponent);
      } catch {
        deny(400, "bad_path", "接口路径编码无效。");
      }
      const [, resource, id, sub, roleId, op, extra] = parts;
      if (resource === "teams" && parts.length === 3 && m === "PUT")
        return json(res, 200, store.updateTeam(actor, id, await teamBody()));
      if (resource === "teams" && parts.length === 3 && m === "GET")
        return json(res, 200, store.getTeam(actor, id));
      if (
        resource === "teams" &&
        parts.length === 4 &&
        sub === "runs" &&
        m === "POST"
      )
        return json(res, 201, store.startRun(actor, id, await readJson(req)));
      if (m === "GET" && p === "/api/runs")
        return json(res, 200, store.listRuns(actor));
      if (resource === "runs" && parts.length === 3 && m === "GET")
        return json(res, 200, store.getRun(actor, id));
      if (
        resource === "runs" &&
        parts.length === 4 &&
        sub === "review" &&
        m === "POST"
      )
        return json(
          res,
          200,
          afterHandoff(store.reviewArtifact(actor, id, await readJson(req))),
        );
      if (resource === "runs" && sub === "roles") {
        if (op === "session" && parts.length === 6 && m === "GET")
          return json(res, 200, await execution.read(actor, id, roleId));
        if (
          op === "session" &&
          extra === "open" &&
          parts.length === 7 &&
          m === "POST"
        ) {
          await readJson(req);
          return json(res, 200, await execution.open(actor, id, roleId));
        }
        if (op === "turns" && parts.length === 6 && m === "POST")
          return json(
            res,
            202,
            execution.submit(actor, id, roleId, await readJson(req)),
          );
        if (
          op === "turns" &&
          parts.length === 8 &&
          parts[7] === "resolve" &&
          m === "POST"
        ) {
          const b = await readJson(req);
          if (b.confirmed !== true)
            deny(400, "confirmation_required", "须先核对原会话。");
          return json(
            res,
            200,
            await execution.resolvePending(actor, id, roleId, extra),
          );
        }
        if (op === "artifacts" && parts.length === 6 && m === "POST") {
          const body = await readJson(req);
          const replay = store.replayedSubmission(actor, id, roleId, body);
          if (replay) return json(res, 200, afterHandoff(replay));
          const run = store.getRun(actor, id);
          const role = run.roles.find((r) => r.id === roleId);
          if (role?.assigneeId !== actor)
            deny(403, "forbidden", "不能提交他人角色的产物。");
          if (run.currentRoleId !== roleId || run.status !== "active")
            deny(409, "not_current", "当前角色不能提交产物。");
          const next = run.roles[run.roles.indexOf(role) + 1];
          if (next?.delivery?.kind === "qa" && !gate)
            deny(503, "gate_unavailable", "此实例尚未启用团队命令执行。");
          const candidate =
            next?.delivery?.kind === "qa"
              ? await gate.capture(run, role)
              : null;
          return json(
            res,
            200,
            afterHandoff(
              store.submitArtifact(actor, id, roleId, body, candidate),
            ),
          );
        }
      }
      deny(404, "not_found", "接口不存在。");
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = Number(error.status || error.statusCode);
      const known = status >= 400 && status <= 599;
      json(res, known ? status : 500, {
        error: known ? error.code : "internal_error",
        message: known ? error.message : "操作未完成，请检查本地服务。",
      });
      if (!known)
        console.error(
          "[ohoo] request failed:",
          error.name || "Error",
          error.code || "INTERNAL",
        );
    }
  });
}
