// 19 — how many turns an agent's run took, beside what it cost.
export default `
  ALTER TABLE run ADD COLUMN turns INTEGER NOT NULL DEFAULT 0;
  `;
