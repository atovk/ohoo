import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["client/main.jsx"],
  outfile: "dist/app.js",
  bundle: true,
  minify: true,
  jsx: "automatic",
  legalComments: "inline",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  new URL("../dist/index.html", import.meta.url),
  `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>ohoo · 本地团队工作台</title><link rel="stylesheet" href="/app.css"></head>
<body><div id="root"></div><script src="/app.js" defer></script></body></html>`,
);
