// 27 — the moment a deploy started serving: set once, at the swap-in,
// distinct from `finished_at` which waits on the tests beside it.
export default `
  ALTER TABLE run ADD COLUMN serving_at TEXT;
  `;
