import { mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function localPaths(env = process.env) {
  const data = path.resolve(
    env.OHOO_DATA_DIR || path.join(homedir(), ".local", "share", "ohoo-mvp"),
  );
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const root = path.resolve(env.OHOO_WORKSPACE_ROOT || path.join(data, "work"));
  if (!env.OHOO_WORKSPACE_ROOT)
    mkdirSync(root, { recursive: true, mode: 0o700 });
  const workspace = realpathSync(root);
  if (!statSync(workspace).isDirectory())
    throw new Error("OHOO_WORKSPACE_ROOT 必须是一个已有目录");
  return { data, workspace, port: Number(env.OHOO_PORT || 4310) };
}

export function resolveWorkspace(root, input) {
  if (input != null && typeof input !== "string")
    throw new Error("工作目录必须为文本");
  const target = realpathSync(path.resolve(root, input || "."));
  const relative = path.relative(root, target);
  if (
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative) ||
    !statSync(target).isDirectory()
  ) {
    throw new Error("角色工作目录必须在已配置的本机工作区内");
  }
  return target;
}
