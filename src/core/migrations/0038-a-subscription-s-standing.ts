// 38 — a subscription's standing (`core/standing.ts`): the last time the
// provider said each window (5-hour, weekly) was full and when it resets,
// and the share of every window the operator keeps for people.
export default `
  CREATE TABLE subscription_limit (
    subscription_id TEXT NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,
    span            TEXT NOT NULL CHECK (span IN ('5h','week')),
    resets_at       TEXT NOT NULL,
    observed_at     TEXT NOT NULL,
    said            TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (subscription_id, span)
  );
  ALTER TABLE subscription ADD COLUMN headroom_pct INTEGER NOT NULL DEFAULT 0
    CHECK (headroom_pct BETWEEN 0 AND 90);
  `;
