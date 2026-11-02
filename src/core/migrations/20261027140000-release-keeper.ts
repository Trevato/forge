// The release keeper (#7557): one row per release it cut, with the
// known-good image it rolls back to and what the probes counted, and the
// holds that stop further cuts. `kind` is `failed` (a verify that failed,
// lifted by a verified release after a pull naming it lands) or `owner`
// (set and lifted by an admin).
export default `
  CREATE TABLE keeper_release (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL UNIQUE,
    sha TEXT NOT NULL,
    known_good_version TEXT NOT NULL,
    known_good_image TEXT NOT NULL,
    stage TEXT NOT NULL,
    cut_at TEXT NOT NULL,
    live_at TEXT,
    finished_at TEXT,
    roll_probes INTEGER NOT NULL DEFAULT 0,
    roll_non200 INTEGER NOT NULL DEFAULT 0,
    probes INTEGER NOT NULL DEFAULT 0,
    pages INTEGER NOT NULL DEFAULT 0,
    bad_in_row INTEGER NOT NULL DEFAULT 0,
    worst_ms INTEGER NOT NULL DEFAULT 0,
    seconds_dark INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE keeper_hold (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    version TEXT NOT NULL,
    reason TEXT NOT NULL,
    probes INTEGER NOT NULL DEFAULT 0,
    bad_in_row INTEGER NOT NULL DEFAULT 0,
    worst_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    cause_pull INTEGER,
    lifted_at TEXT,
    lifted_by TEXT
  );
`;
