// 42 — every credential is a subscription (`core/subscriptions.ts`): the
// forge's own token from its environment becomes the row `platform`, with
// no sealed token, so its windows and spend read like any account's. The
// ledger's runs on it, once `NULL`, are its. The ledger gains the run's
// kind (build, plan, review, check) and a `running` line, written as a
// session reports its spend and replaced when it ends. SQLite cannot widen
// a CHECK in place, so the ledger is copied into a new table.
export default `
  INSERT OR IGNORE INTO subscription (id, name, kind, token_enc)
    VALUES ('platform', 'platform (env)', 'oauth', '');
  CREATE TABLE usage_next (
    run_id          TEXT PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
    repo_id         TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_id        TEXT,
    agent_id        TEXT,
    subscription_id TEXT,
    kind            TEXT NOT NULL DEFAULT 'build'
                    CHECK (kind IN ('build','plan','review','check')),
    tokens_in       INTEGER NOT NULL DEFAULT 0,
    tokens_out      INTEGER NOT NULL DEFAULT 0,
    cost_usd        REAL NOT NULL DEFAULT 0,
    wall_ms         INTEGER NOT NULL DEFAULT 0,
    outcome         TEXT NOT NULL CHECK (outcome IN ('ok','failed','paused','running')),
    at              TEXT NOT NULL
  );
  INSERT INTO usage_next
    SELECT u.run_id, u.repo_id, u.issue_id, u.agent_id,
           COALESCE(u.subscription_id, 'platform'),
           CASE r.reason WHEN 'review' THEN 'review'
                         WHEN 'check_failed' THEN 'check' ELSE 'build' END,
           u.tokens_in, u.tokens_out, u.cost_usd, u.wall_ms, u.outcome, u.at
      FROM usage u LEFT JOIN run r ON r.id = u.run_id;
  DROP TABLE usage;
  ALTER TABLE usage_next RENAME TO usage;
  CREATE INDEX usage_at ON usage(at);
  CREATE INDEX usage_repo ON usage(repo_id, at);
  CREATE INDEX usage_subscription ON usage(subscription_id, at);
  UPDATE run SET subscription_id = 'platform'
   WHERE kind = 'agent' AND subscription_id IS NULL;
  `;
