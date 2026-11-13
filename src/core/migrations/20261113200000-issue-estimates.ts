// Estimates of when an issue's work happens (#11955): one row per estimate, never edited.
// A new estimate for the same issue and event supersedes the old one on the page; the old
// rows stay as data. The forge alone sets `actual_at` (the event happened) or `voided_at`
// (the issue closed as dropped or split, or moved to Not now). `base_json` is the base rate shown
// when the estimate was made, so the history itself can be scored. Additive: one table.
export default `
  CREATE TABLE issue_estimate (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id   TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_id  TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    event     TEXT NOT NULL CHECK (event IN ('pull_opened','merged','live')),
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
  CREATE INDEX issue_estimate_issue ON issue_estimate(issue_id, event, id);
  CREATE INDEX issue_estimate_open ON issue_estimate(event, repo_id) WHERE actual_at IS NULL AND voided_at IS NULL;
  CREATE INDEX issue_estimate_repo ON issue_estimate(repo_id, made_at);
`;
