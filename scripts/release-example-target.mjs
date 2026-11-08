import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { localPaths } from "../server/config.mjs";
import { targetStatePath } from "../server/delivery-gate.mjs";

const [operation, runId] = process.argv.slice(2);
if (!["status", "cleanup"].includes(operation) || !runId) {
  console.error("用法：npm run example:target -- status|cleanup <运行 ID>");
  process.exit(2);
}
const cfg = localPaths(),
  db = new DatabaseSync(path.join(cfg.data, "workbench.sqlite"), {
    readOnly: true,
  });
const row = db
  .prepare("SELECT team_id,roles_json FROM runs WHERE id=?")
  .get(runId);
db.close();
const release =
  row &&
  JSON.parse(row.roles_json).find((role) => role.delivery?.kind === "release");
if (
  !release ||
  JSON.stringify(release.delivery.deploy) !==
    JSON.stringify(["node", "team-release.mjs", "deploy"])
) {
  console.error("找不到使用订单示例发布 CLI 的运行。");
  process.exit(1);
}
const state = targetStatePath(cfg.data, row.team_id, release.delivery.target);
if (!existsSync(state)) {
  console.log("此团队的测试目标尚未部署。");
  process.exit(0);
}
const cli = fileURLToPath(
  new URL("../examples/test-release/team-release.mjs", import.meta.url),
);
const result = spawnSync(process.execPath, [cli, operation], {
  stdio: "inherit",
  env: { ...process.env, OHOO_RELEASE_STATE_DIR: state },
});
process.exitCode = result.status ?? 1;
