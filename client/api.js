export const requestId = () => crypto.randomUUID();

export async function api(path, { method = "GET", body, signal } = {}) {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error("无效的 API 路径。");
  let response;
  try {
    response = await fetch("/api" + path, {
      method,
      signal,
      credentials: "same-origin",
      cache: "no-store",
      headers: method === "GET" ? {} : { "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error("无法连接 ohoo 本地服务，请检查服务状态并重试。");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.message || "请求未成功。");
    error.status = response.status;
    error.code = data?.error;
    if (response.status === 401 && path !== "/me" && path !== "/login")
      window.dispatchEvent(new Event("ohoo:auth-expired"));
    throw error;
  }
  return data;
}
