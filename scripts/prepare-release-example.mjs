import { cp, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { localPaths } from "../server/config.mjs";

const dir = await mkdtemp(path.join(localPaths().workspace, "orders-release-"));
await cp(new URL("../examples/test-release/", import.meta.url), dir, {
  recursive: true,
});
console.log(dir);
