// 37 — the usage ledger (`core/usage.ts`): what each agent run spent,
// attributed to subscription, app, agent and issue. `subscription_id` is
// text, not a reference: a removed account's spend stays counted.
//
// Written to survive one ordering accident: for a while this migration
// was numbered 36, and a preview's database migrated then has the ledger
// at 36 and never ran `share`. So both are created only if missing —
// a no-op everywhere 36 was `share`, the repair where it was not. The
// `share` DDL is migration 36's, verbatim.
export default `
  CREATE TABLE IF NOT EXISTS share (
    id           TEXT PRIMARY KEY,
    item_id      TEXT NOT NULL,
    sender_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    recipient_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    repo_id      TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    link         TEXT NOT NULL,
    what         TEXT NOT NULL,
    state        TEXT NOT NULL CHECK (state IN ('delivered','queued','dropped')),
    created_at   TEXT NOT NULL,
    delivered_at TEXT,
    UNIQUE (item_id, recipient_id)
  );
  CREATE INDEX IF NOT EXISTS share_recipient ON share(recipient_id, state);
  CREATE INDEX IF NOT EXISTS share_sender ON share(sender_id, state);

  CREATE TABLE IF NOT EXISTS usage (
    run_id          TEXT PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
    repo_id         TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_id        TEXT,
    agent_id        TEXT,
    subscription_id TEXT,
    tokens_in       INTEGER NOT NULL DEFAULT 0,
    tokens_out      INTEGER NOT NULL DEFAULT 0,
    cost_usd        REAL NOT NULL DEFAULT 0,
    wall_ms         INTEGER NOT NULL DEFAULT 0,
    outcome         TEXT NOT NULL CHECK (outcome IN ('ok','failed','paused')),
    at              TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
  CREATE INDEX IF NOT EXISTS usage_repo ON usage(repo_id, at);
  CREATE INDEX IF NOT EXISTS usage_subscription ON usage(subscription_id, at);
  `;
