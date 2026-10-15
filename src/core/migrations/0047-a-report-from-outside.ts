// 47 — a report from outside (`core/reports.ts`): words a stranger left on
// a public repository, held apart from issues so nothing that reads issues
// (the crew, the feed, search, the MCP) reads them until a person who
// writes accepts one, which opens an ordinary issue in that person's name.
export default `
  CREATE TABLE IF NOT EXISTS report (
    id           TEXT PRIMARY KEY,
    repo_id      TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL,
    page         TEXT,
    state        TEXT NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','accepted','dismissed')),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    decided_by   TEXT REFERENCES user(id) ON DELETE SET NULL,
    decided_at   TEXT,
    issue_number INTEGER
  );
  CREATE INDEX IF NOT EXISTS report_waiting ON report(repo_id, state, id);
  `;
