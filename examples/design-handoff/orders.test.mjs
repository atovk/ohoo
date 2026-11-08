import assert from "node:assert/strict";
import test from "node:test";
import { listOrders } from "./orders.mjs";

test("the list filters by account and status before sorting and paging", () => {
  const rows = [
    { id: "04", account: "north", status: "paid" },
    { id: "01", account: "north", status: "paid" },
    { id: "02", account: "south", status: "paid" },
    { id: "03", account: "north", status: "draft" },
    { id: "05", account: "north", status: "paid" },
  ];
  const q = { account: "north", status: "paid" };
  assert.deepEqual(listOrders(rows, q).items.map((row) => row.id), ["01", "04"]);
  assert.deepEqual(listOrders(rows, { ...q, page: 2 }).items.map((row) => row.id), ["05"]);
  assert.equal(listOrders(rows, q).total, 3);
});
