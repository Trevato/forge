// A proof is a run with a state (#7706): the full suite on a pull's head
// squashed onto the base, before the pull joins the merge queue. `run` has a
// CHECK on its kind that SQLite cannot widen without a rebuild an old process
// would not survive (#875), so a proof's rows sit beside it and are read as
// runs of kind `proof` (`core/proof_runs.ts`). `state` is a run's: queued
// (waiting for a check slot), running, ok, failed, cancelled (cut off).
export default `
  CREATE TABLE IF NOT EXISTS proof_run (
    id          TEXT PRIMARY KEY,
    repo_id     TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_id    TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    head        TEXT NOT NULL,
    base        TEXT NOT NULL DEFAULT '',
    state       TEXT NOT NULL DEFAULT 'queued'
                CHECK (state IN ('queued','running','ok','failed','cancelled')),
    summary     TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    started_at  TEXT,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS proof_run_repo ON proof_run(repo_id, id DESC);
  CREATE INDEX IF NOT EXISTS proof_run_issue ON proof_run(issue_id, id DESC);
  `;
