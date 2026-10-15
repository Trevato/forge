// 52 — a whole-life budget on a sealed account, in dollars (#601): the
// most its runs may ever spend, summed from the run ledger. Null is none.
// A spawned child's starter key carries one, so the spawner's money ends
// where they said. A locked budget was set by whoever made this forge:
// its admin may lower it, never raise or clear it. A run on a budgeted
// account reserves what it may spend when it picks the account, so runs
// started together are counted together.
export default `
  ALTER TABLE subscription ADD COLUMN budget_usd REAL
    CHECK (budget_usd IS NULL OR budget_usd > 0);
  ALTER TABLE subscription ADD COLUMN budget_locked INTEGER NOT NULL DEFAULT 0
    CHECK (budget_locked IN (0, 1));
  ALTER TABLE run ADD COLUMN budget_reserved_usd REAL;
  `;
