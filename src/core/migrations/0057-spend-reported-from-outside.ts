// 57 — spend reported from outside (`core/outside_spend.ts`): what a
// session the forge did not run (a build team, a person's own assistant)
// says a change cost it. Shown beside the crew's own runs, never added to
// them, and never read by a limit: it is a claim, not a measurement.
export default `
  CREATE TABLE outside_spend (
    id          TEXT PRIMARY KEY,
    repo_id     TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_id    TEXT REFERENCES issue(id) ON DELETE SET NULL,
    reporter_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    who         TEXT NOT NULL,
    model       TEXT NOT NULL DEFAULT '',
    tokens_in   INTEGER NOT NULL DEFAULT 0,
    tokens_out  INTEGER NOT NULL DEFAULT 0,
    usd         REAL NOT NULL DEFAULT 0,
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX outside_spend_repo ON outside_spend(repo_id, created_at);
  `;
