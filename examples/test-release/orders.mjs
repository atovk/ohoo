// Existing list endpoint used by the design exercise. The new export should
// have the same visibility rules and ordering as this list.
function matchingOrderRows(rows, { account, status }) {
  return rows
    .filter((row) => row.account === account && row.status === status)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function exportOrderRows(rows, { account, status }) {
  return matchingOrderRows(rows, { account, status });
}

export function listOrders(rows, { account, status, page = 1, pageSize = 2 }) {
  const matching = matchingOrderRows(rows, { account, status });
  const offset = (page - 1) * pageSize;
  return {
    total: matching.length,
    items: matching.slice(offset, offset + pageSize),
  };
}
