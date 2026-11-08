// The agent invokes this helper inside its own Paseo session. Commands, target
// and candidate are resolved server-side from the immutable team/run binding.
import { readFile } from "node:fs/promises";
const [grantFile, operation] = process.argv.slice(2);
try {
  if (!grantFile || !["test", "deploy", "verify"].includes(operation))
    throw Error("需要授权文件路径和 test / deploy / verify。");
  const { base, jobId, token } = JSON.parse(await readFile(grantFile, "utf8"));
  const url = new URL(base);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password
  )
    throw Error("执行入口必须是本机 ohoo。");
  url.pathname =
    "/api/role-actions/" + encodeURIComponent(jobId) + "/" + operation;
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(105000),
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: "{}",
  });
  const action = await response.json();
  if (!response.ok) throw Error(action.message || "受托动作未执行。");
  console.log(
    "ohoo %s · %s · %s · exit=%s",
    operation,
    action.id,
    action.status,
    action.exitCode ?? "未知",
  );
  console.log(action.output || "（无命令输出）");
  if (action.status !== "succeeded") process.exitCode = 1;
} catch (error) {
  console.error("ohoo 工具调用失败：%s", error.message);
  process.exitCode = 1;
}
