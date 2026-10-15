// 26 — subscriptions: the Claude accounts the crew works on, sealed, and the
// grants that say which repository or organization (and which agent) each
// one pays for. A run remembers the account it spent, for the ledger.
export default `
  CREATE TABLE subscription (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind          TEXT NOT NULL CHECK (kind IN ('oauth','api_key')),
    token_enc     TEXT NOT NULL,
    resting_until TEXT,
    resting_said  TEXT NOT NULL DEFAULT '',
    last_used_at  TEXT,
    created_by    TEXT REFERENCES user(id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE subscription_grant (
    scope_id        TEXT NOT NULL,
    agent_id        TEXT NOT NULL DEFAULT '',
    subscription_id TEXT NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,
    PRIMARY KEY (scope_id, agent_id, subscription_id)
  );
  CREATE INDEX subscription_grant_scope ON subscription_grant (scope_id, agent_id);
  ALTER TABLE run ADD COLUMN subscription_id TEXT;
  `;
