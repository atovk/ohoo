// Existing list endpoint used by the design exercise. The new export should
// have the same visibility rules and ordering as this list.
export function listOrders(rows, { account, status, page = 1, pageSize = 2 }) {
  const matching = rows
    .filter((row) => row.account === account && row.status === status)
    .sort((a, b) => a.id.localeCompare(b.id));
  const offset = (page - 1) * pageSize;
  return {
    total: matching.length,
    items: matching.slice(offset, offset + pageSize),
  };
}
