// 91 — where a check ran (#1815): `process` (the forge's own cell) or `job`
// (a cluster Job), and the node a Job's pod landed on. Empty: not recorded.
export default `
  ALTER TABLE run ADD COLUMN placement TEXT NOT NULL DEFAULT '';
  ALTER TABLE run ADD COLUMN node TEXT NOT NULL DEFAULT '';
  `;
