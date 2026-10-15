// 76 — the sentinel's memory (#1131): each hunt, and each finding with the
// issue it became, so a fault is filed once and a returning one is told
// apart from one that never left.
export default `
  CREATE TABLE IF NOT EXISTS sentinel_hunt (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    at    TEXT NOT NULL,
    found INTEGER NOT NULL,
    filed INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sentinel_finding (
    key        TEXT NOT NULL,
    issue_id   TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    evidence   TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen  TEXT NOT NULL,
    PRIMARY KEY (key, issue_id)
  );
  `;
