// 87 — supersession and repeats (#654): a thought that repeats or takes
// back an earlier one links to it, and an issue a repeat raised is read
// ahead of the rest in the ready order.
export default `
  CREATE TABLE thought_link (
    thought_id TEXT NOT NULL,
    other_id   TEXT NOT NULL,
    relation   TEXT NOT NULL CHECK (relation IN ('repeats', 'supersedes')),
    PRIMARY KEY (thought_id, other_id, relation)
  );
  CREATE INDEX thought_link_other ON thought_link(other_id);
  CREATE TABLE issue_raise (
    issue_id  TEXT PRIMARY KEY,
    raised_at TEXT NOT NULL,
    times     INTEGER NOT NULL DEFAULT 1
  );
  `;
