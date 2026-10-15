// 17 — checks.
//
// A repository's own check (`check` in forge.json) runs as a run of a
// third kind, on every push a pull or the default branch takes. SQLite
// cannot widen a CHECK constraint in place, so the table is rebuilt
// around the wider one; nothing references run by foreign key.
export default `
  CREATE TABLE run_v2 (
    id          TEXT PRIMARY KEY,
    repo_id     TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('deploy','agent','check')),
    issue_id    TEXT REFERENCES issue(id) ON DELETE CASCADE,
    env         TEXT NOT NULL DEFAULT '',
    commit_oid  TEXT NOT NULL DEFAULT '',
    branch      TEXT NOT NULL DEFAULT '',
    state       TEXT NOT NULL DEFAULT 'queued'
                CHECK (state IN ('queued','running','ok','failed','cancelled')),
    summary     TEXT NOT NULL DEFAULT '',
    actor_id    TEXT REFERENCES user(id) ON DELETE SET NULL,
    reason      TEXT NOT NULL DEFAULT '',
    session_id  TEXT NOT NULL DEFAULT '',
    cost_usd    REAL NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    started_at  TEXT,
    finished_at TEXT,
    not_before  TEXT,
    attempt     INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO run_v2 (id, repo_id, kind, issue_id, env, commit_oid, branch, state, summary,
                      actor_id, reason, session_id, cost_usd, created_at, started_at,
                      finished_at, not_before, attempt)
    SELECT id, repo_id, kind, issue_id, env, commit_oid, branch, state, summary,
           actor_id, reason, session_id, cost_usd, created_at, started_at,
           finished_at, not_before, attempt FROM run;
  DROP TABLE run;
  ALTER TABLE run_v2 RENAME TO run;
  CREATE INDEX run_repo ON run(repo_id, id DESC);
  CREATE INDEX run_issue ON run(issue_id, id DESC) WHERE issue_id IS NOT NULL;
  CREATE INDEX run_queue ON run(state, id) WHERE state IN ('queued','running');
  `;
