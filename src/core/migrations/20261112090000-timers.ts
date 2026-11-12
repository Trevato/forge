// `timer` and `timer_run` (#11595): what the forge fires at an app on a clock. A timer is a row: a
// schedule's next occurrence (kind 'schedule', re-armed after each run) or a one-shot an app armed
// (kind 'once', gone after its run). `scheduled_at` is the instant the occurrence was meant for,
// `due_at` when its next attempt is due (later than scheduled while it retries). `timer_run` is the
// history of every occurrence. `timer_sync` remembers which production commit's declaration the
// schedule rows were read from. New tables only. Additive.
export default `
  CREATE TABLE timer (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id        TEXT    NOT NULL,
    env           TEXT    NOT NULL,
    kind          TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    key           TEXT    NOT NULL,
    path          TEXT    NOT NULL,
    body          BLOB,
    cron          TEXT,
    timezone      TEXT,
    timeout_ms    INTEGER NOT NULL,
    retries       INTEGER NOT NULL,
    catch_up_ms   INTEGER NOT NULL,
    scheduled_at  INTEGER NOT NULL,
    due_at        INTEGER NOT NULL,
    attempt       INTEGER NOT NULL DEFAULT 0,
    paused        INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    UNIQUE (app_id, env, kind, name, key)
  );
  CREATE INDEX timer_due ON timer (due_at) WHERE paused = 0;
  CREATE TABLE timer_run (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id       TEXT    NOT NULL,
    env          TEXT    NOT NULL,
    name         TEXT    NOT NULL,
    idem_key     TEXT    NOT NULL,
    scheduled_at INTEGER NOT NULL,
    started_at   INTEGER NOT NULL,
    finished_at  INTEGER NOT NULL,
    attempts     INTEGER NOT NULL,
    status       TEXT    NOT NULL,
    http_status  INTEGER,
    response     TEXT,
    error        TEXT,
    late_ms      INTEGER NOT NULL DEFAULT 0,
    late_reason  TEXT,
    duration_ms  INTEGER NOT NULL
  );
  CREATE INDEX timer_run_app ON timer_run (app_id, name, id);
  CREATE TABLE timer_sync (
    app_id     TEXT NOT NULL,
    env        TEXT NOT NULL,
    commit_oid TEXT NOT NULL,
    PRIMARY KEY (app_id, env)
  ) WITHOUT ROWID;
  `;
