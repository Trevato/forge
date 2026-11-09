// A run of kind `pull` (#10042): one row per `POST /pull` the forge made to an
// adapter (docs/ADAPTERS.md), written by `recordPull` (`apps/pull.ts`) through
// `createPullRun` (`core/runs.ts`). Its own table, not a `run` row: `run.kind`'s
// CHECK can only be widened by rebuilding `run`, and a migration only adds
// (`test/schema-additive.test.ts`). `written`, `skipped` and `failed` are the
// answer's `pulled`, `skipped` and `errors`, 0..1,000,000; `cursor` is empty on
// a failed pull, whose `reason` says what was wrong; `repeat` marks an answer
// whose cursor matched the last good one, recorded with nothing written.
// `pull_run_app` serves an app's list newest first; `pull_run_app_ok` serves
// the last good cursor. No foreign key, like `feature_fire`: `deleteApp`
// clears the rows. Additive.
export default `
  CREATE TABLE pull_run (
    id          TEXT PRIMARY KEY,
    app_id      TEXT NOT NULL,
    state       TEXT NOT NULL CHECK (state IN ('ok','failed')),
    written     INTEGER NOT NULL DEFAULT 0 CHECK (written BETWEEN 0 AND 1000000),
    skipped     INTEGER NOT NULL DEFAULT 0 CHECK (skipped BETWEEN 0 AND 1000000),
    failed      INTEGER NOT NULL DEFAULT 0 CHECK (failed BETWEEN 0 AND 1000000),
    cursor      TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
    reason      TEXT NOT NULL DEFAULT '',
    repeat      INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX pull_run_app ON pull_run(app_id, id DESC);
  CREATE INDEX pull_run_app_ok ON pull_run(app_id, id DESC) WHERE state = 'ok';
  `;
