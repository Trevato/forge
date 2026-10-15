// 49 — the asks ledger (`core/ask_ledger.ts`): each time something asked
// a person, and how it ended — acted on, dismissed, or gone by itself —
// so noise shows up as a number. One row per raising; history, never edited
// but to close it.
export default `
  CREATE TABLE ask_ledger (
    id         TEXT PRIMARY KEY,
    viewer_id  TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    ask_id     TEXT NOT NULL,
    repo_id    TEXT REFERENCES repo(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    raised_at  TEXT NOT NULL,
    ended_at   TEXT,
    ended_how  TEXT CHECK (ended_how IN ('acted','dismissed','expired'))
  );
  CREATE INDEX ask_ledger_open ON ask_ledger(viewer_id, ended_at);
  CREATE INDEX ask_ledger_raised ON ask_ledger(viewer_id, raised_at);
  `;
