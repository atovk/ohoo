import { listOrders } from "./orders.mjs";

export const orders = [
  { id: "04", account: "north", status: "paid" },
  { id: "02", account: "south", status: "paid" },
  { id: "06", account: "north", status: "draft" },
  { id: "01", account: "north", status: "paid" },
  { id: "05", account: "north", status: "paid" },
];

export function orderHttpHandler(req, res, digest) {
  const url = new URL(req.url, "http://localhost");
  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", candidateDigest: digest }));
    return;
  }
  if (url.pathname !== "/orders.csv") {
    res.writeHead(404).end();
    return;
  }
  // Test identities are fixed on the server. A query parameter cannot grant another account.
  const account = new Map([
    ["Bearer demo-north", "north"],
    ["Bearer demo-south", "south"],
  ]).get(req.headers.authorization);
  if (!account) {
    res.writeHead(401).end();
    return;
  }
  const query = { account, status: url.searchParams.get("status") ?? "paid" };
  const rows = listOrders(orders, query).items;
  const csv = [
    "id,account,status",
    ...rows.map((row) => [row.id, row.account, row.status].join(",")),
  ];
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "X-Candidate-SHA256": digest,
  });
  res.end(csv.join("\r\n") + "\r\n");
}
