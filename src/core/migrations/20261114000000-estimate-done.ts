// An estimate can mean "finished" (#11955): the event `done` joins pull_opened, merged and live,
// for an issue that takes several pulls. SQLite cannot widen a CHECK in place, so the table is
// copied into a new one and its indexes made again; nothing refers to it.
export default `
  CREATE TABLE issue_estimate_next (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id   TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_id  TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    event     TEXT NOT NULL CHECK (event IN ('pull_opened','merged','live','done')),
    p50_at    TEXT NOT NULL,
    p90_at    TEXT NOT NULL,
    made_at   TEXT NOT NULL,
    by_id     TEXT NOT NULL REFERENCES user(id),
    by_kind   TEXT NOT NULL CHECK (by_kind IN ('person','agent')),
    basis     TEXT NOT NULL DEFAULT '',
    base_json TEXT NOT NULL DEFAULT 'null',
    size      TEXT NOT NULL,
    kind      TEXT NOT NULL DEFAULT '',
    actual_at TEXT,
    voided_at TEXT
  );
  INSERT INTO issue_estimate_next SELECT * FROM issue_estimate;
  DROP TABLE issue_estimate;
  ALTER TABLE issue_estimate_next RENAME TO issue_estimate;
  CREATE INDEX issue_estimate_issue ON issue_estimate(issue_id, event, id);
  CREATE INDEX issue_estimate_open ON issue_estimate(event, repo_id) WHERE actual_at IS NULL AND voided_at IS NULL;
  CREATE INDEX issue_estimate_repo ON issue_estimate(repo_id, made_at);
`;
