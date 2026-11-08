import assert from "node:assert/strict";
import test from "node:test";
import { exportOrderRows, listOrders } from "./orders.mjs";

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

// EXPORT-8786734: full export preserves list visibility and ordering.
const exportRows = [
  { id: "05", account: "north", status: "paid" },
  { id: "01", account: "north", status: "paid" },
  { id: "02", account: "south", status: "paid" },
  { id: "03", account: "north", status: "draft" },
  { id: "04", account: "north", status: "paid" },
];
const query = { account: "north", status: "paid" };

test("export includes all matching rows beyond the default page in id order", () => {
  const before = exportRows.slice();
  const expected = [exportRows[1], exportRows[4], exportRows[0]];
  const result = exportOrderRows(exportRows, query);
  assert.deepEqual(result, expected);
  assert.deepEqual(listOrders(exportRows, query).items, expected.slice(0, 2));
  assert.deepEqual(result, [
    ...listOrders(exportRows, query).items,
    ...listOrders(exportRows, { ...query, page: 2 }).items,
  ]);
  assert.deepEqual(exportRows, before);
});

test("export isolates accounts in both directions", () => {
  assert.deepEqual(exportOrderRows(exportRows, query),
    [exportRows[1], exportRows[4], exportRows[0]]);
  assert.deepEqual(exportOrderRows(exportRows, { ...query, account: "south" }),
    [exportRows[2]]);
});

test("export filters paid and draft statuses", () => {
  assert.deepEqual(exportOrderRows(exportRows, query),
    [exportRows[1], exportRows[4], exportRows[0]]);
  assert.deepEqual(exportOrderRows(exportRows, { ...query, status: "draft" }),
    [exportRows[3]]);
});

test("export preserves input order for equal ids without deduplicating", () => {
  const rows = [
    { id: "02", marker: "A", ...query },
    { id: "01", marker: "X", ...query },
    { id: "02", marker: "B", ...query },
    { id: "03", marker: "Y", ...query },
  ];
  const expected = [rows[1], rows[0], rows[2], rows[3]];
  assert.deepEqual(exportOrderRows(rows, query), expected);
  assert.deepEqual([
    ...listOrders(rows, query).items,
    ...listOrders(rows, { ...query, page: 2 }).items,
  ], expected);
});

test("export returns an empty array for empty input", () => {
  assert.deepEqual(exportOrderRows([], query), []);
});

test("export returns an empty array when no account matches", () => {
  assert.deepEqual(exportOrderRows([exportRows[2]], query), []);
});

test("export returns an empty array when the account matches but status does not", () => {
  assert.deepEqual(exportOrderRows([exportRows[3]], query), []);
});
