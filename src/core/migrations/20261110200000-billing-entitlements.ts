// What each forge is entitled to (#11134), one row per forge, every change
// kept. Additive. A forge with no row reads as
// active on the plan matching its size (src/billing/store.ts).
export default `
  CREATE TABLE entitlement (
    forge TEXT PRIMARY KEY,
    plan TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','grace','none')),
    period_end INTEGER,
    payer TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT 'none',
    customer_id TEXT NOT NULL DEFAULT '',
    subscription_id TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE entitlement_change (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    forge TEXT NOT NULL,
    from_plan TEXT NOT NULL,
    to_plan TEXT NOT NULL,
    from_status TEXT NOT NULL,
    to_status TEXT NOT NULL,
    source TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX entitlement_change_forge ON entitlement_change (forge, id);
  `;
