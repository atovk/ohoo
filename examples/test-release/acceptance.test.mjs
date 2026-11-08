import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { orderHttpHandler } from "./orders-http.mjs";

test("CSV through the HTTP entry includes every matching page in list order, scoped to its bearer account", async (t) => {
  const server = createServer((req, res) => orderHttpHandler(req, res, "qa"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/orders.csv`;
  async function get(token, query) {
    const response = await fetch(base + "?" + query, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!token) {
      assert.equal(response.status, 401);
      return;
    }
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/csv/);
    return (await response.text()).trimEnd().split(/\r?\n/);
  }
  await get(null, "status=paid");
  const columns = "id,account,status";
  assert.deepEqual(await get("demo-north", "status=paid&account=south"), [
    columns,
    "01,north,paid",
    "04,north,paid",
    "05,north,paid",
  ]);
  assert.deepEqual(await get("demo-south", "status=paid&account=north"), [
    columns,
    "02,south,paid",
  ]);
  assert.deepEqual(await get("demo-north", "status=refunded"), [columns]);
});
