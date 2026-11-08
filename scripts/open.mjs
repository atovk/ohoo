import { spawn } from "node:child_process";
import { localPaths } from "../server/config.mjs";
import { ownerKey } from "../server/auth.mjs";
const { data, port } = localPaths();
const base = `http://127.0.0.1:${port}`;
try {
  const health = await fetch(base + "/api/health", {
    signal: AbortSignal.timeout(2500),
  });
  if ((await health.json()).service !== "ohoo-local")
    throw new Error("服务未就绪");
} catch {
  console.error("请先执行 npm start 启动本地服务。");
  process.exit(1);
}
const url = base + "/#owner=" + encodeURIComponent(ownerKey(data));
const command =
  process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "rundll32"
      : "xdg-open";
const args =
  process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
const browser = spawn(command, args, { stdio: "ignore" });
browser.on("error", () => {
  console.error("无法打开浏览器。请在登录页按照说明使用本机访问密钥。");
  process.exitCode = 1;
});
browser.on("exit", (code) => {
  if (code) process.exitCode = 1;
});
