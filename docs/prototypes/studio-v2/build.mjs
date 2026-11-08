import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/App.jsx"],
  outdir: "dist",
  bundle: true,
  write: false,
  format: "iife",
  minify: true,
  legalComments: "inline",
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".svg": "dataurl" },
});
const js = result.outputFiles
  .find((x) => x.path.endsWith(".js"))
  .text.replace(/<\/script/gi, "<\\/script");
const css = result.outputFiles.find((x) => x.path.endsWith(".css")).text;
const html =
  '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="ohoo Team 工作台完整流程，本地交互设计原型"><title>ohoo Studio · 团队协作工作台</title><style>' +
  css +
  '</style></head><body><div id="root"></div><script>' +
  js +
  "</script></body></html>";
await writeFile(new URL("index.html", import.meta.url), html);
console.log(
  "Built standalone index.html (" +
    Math.round(Buffer.byteLength(html) / 1024) +
    " KiB).",
);
