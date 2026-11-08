// Code scanning (#9593): what a push's or the nightly pass's scan found in a
// repository, one row per finding fingerprint (never the matched text), and
// a person's acceptance with its reason. `scan_run` is when each kind of pass
// last ran on each repository, so the nightly tick picks the ones due, and
// how many files it could not read, so a partial pass says so.
// New tables only. Additive.
export default `
  CREATE TABLE scan_finding (
    id              INTEGER PRIMARY KEY,
    repo_id         TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    fingerprint     TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('secret', 'advisory', 'static')),
    severity        TEXT NOT NULL CHECK (severity IN ('high', 'medium')),
    rule            TEXT NOT NULL,
    path            TEXT NOT NULL,
    line            INTEGER NOT NULL,
    oid             TEXT NOT NULL,
    found_at        TEXT NOT NULL,
    accepted_by     TEXT REFERENCES user(id) ON DELETE SET NULL,
    accepted_reason TEXT,
    accepted_at     TEXT,
    UNIQUE (repo_id, fingerprint)
  );
  CREATE TABLE scan_run (
    repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    kind    TEXT NOT NULL CHECK (kind IN ('push', 'nightly')),
    oid     TEXT NOT NULL,
    at      TEXT NOT NULL,
    skipped INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (repo_id, kind)
  );
  `;
