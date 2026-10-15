// 41 — the meter (`core/meter.ts`): what an app used, in the two
// quantities a forge charges for. `meter` is one row per awake interval
// of an environment, `ended` NULL while it runs and `beat_at` the last
// instant it was seen running, so a crash is closed there at boot.
// `storage` is one row per hourly sample of an app's bytes. `repo_id` is
// text, not a reference: removing an app does not erase what it used.
export default `
  CREATE TABLE meter (
    id         INTEGER PRIMARY KEY,
    repo_id    TEXT NOT NULL,
    env        TEXT NOT NULL,
    placement  TEXT NOT NULL CHECK (placement IN ('owned','cloud')),
    started_at TEXT NOT NULL,
    beat_at    TEXT NOT NULL,
    ended_at   TEXT
  );
  CREATE INDEX meter_repo ON meter(repo_id, started_at);
  CREATE UNIQUE INDEX meter_open ON meter(repo_id, env) WHERE ended_at IS NULL;

  CREATE TABLE storage (
    id         INTEGER PRIMARY KEY,
    repo_id    TEXT NOT NULL,
    data_bytes INTEGER NOT NULL CHECK (data_bytes >= 0),
    repo_bytes INTEGER NOT NULL CHECK (repo_bytes >= 0),
    at         TEXT NOT NULL
  );
  CREATE INDEX storage_repo ON storage(repo_id, at);
  CREATE INDEX storage_at ON storage(at);
  `;
