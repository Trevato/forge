// The throughput keeper (#7645): what it found binding now (one row), and
// each attempt it made, asked or filed (`flow/keeper.ts`). An attempt waits
// `pending` until its effect is checked, then is `worked` or `undone`; `asked`
// is a question for the owner with one button; `filed` is an issue it opened
// once for a cause it cannot act on.
export default `
  CREATE TABLE IF NOT EXISTS keeper_state (
    id     INTEGER PRIMARY KEY CHECK (id = 1),
    cause  TEXT NOT NULL DEFAULT '',
    says   TEXT NOT NULL DEFAULT '',
    at     INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS keeper_attempt (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        INTEGER NOT NULL,
    cause     TEXT NOT NULL,
    action    TEXT NOT NULL,
    repo_id   TEXT NOT NULL DEFAULT '',
    says      TEXT NOT NULL DEFAULT '',
    outcome   TEXT NOT NULL CHECK (outcome IN ('pending','worked','undone','asked','answered','filed')),
    check_at  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS keeper_attempt_at ON keeper_attempt(at DESC);
  `;
