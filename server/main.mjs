import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "./store.mjs";
import { createAuth } from "./auth.mjs";
import { createExecution } from "./execution.mjs";
import { createHttpService } from "./http.mjs";
import { localPaths } from "./config.mjs";
import * as paseo from "./paseo.mjs";
import { createDeliveryGate } from "./delivery-gate.mjs";

const config = localPaths();
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
  throw Error("OHOO_PORT 无效");
// Only one controller per data directory may recover external actions.
const controllerLease = new DatabaseSync(path.join(config.data, "controller.sqlite"));
try {
  controllerLease.exec("BEGIN IMMEDIATE");
} catch (error) {
  controllerLease.close();
  throw new Error("该数据目录已有控制服务，不能同时恢复或派发外部动作。", {cause:error});
}
const store = createStore(path.join(config.data, "workbench.sqlite"), {
  ownerName: process.env.OHOO_OWNER_NAME || "本机负责人",
});
const auth = createAuth(config.data);
const gate = createDeliveryGate(store, config);
const execution = createExecution(store, paseo, config.workspace, gate);
const server = createHttpService({
  store,
  auth,
  execution,
  runtime: paseo,
  workspace: config.workspace,
  gate,
});
server.on("error", (err) => {
  console.error("ohoo 启动失败：", err.message);
  process.exit(1);
});
server.listen(config.port, "127.0.0.1", () => {
  console.log(`ohoo 已启动：http://127.0.0.1:${config.port}/`);
  console.log("首次以所有者身份打开：npm run open");
  store.recoverDeliveryActions();
  execution.recover().catch(() => console.error("待定回合尚待核对。"));
});
const sweep = setInterval(() => execution.recover().catch(() => {}), 15_000);
sweep.unref();
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(sweep);
  execution.stop();
  server.close(() => {
    auth.close();
    store.close();
    controllerLease.close();
    process.exit(0);
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
