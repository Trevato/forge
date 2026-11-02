// What a red batch turned out to be (#7639): one row per red the merge queue
// named — the pull it handed back with the failing tests (`real`), or a red
// that is the machine's, not a pull's (`load`: infrastructure twice, a flake).
// Rows past a week are pruned by `keepVerdict`. A new table.
export default `
  CREATE TABLE IF NOT EXISTS queue_verdict (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('real', 'load')),
    why TEXT NOT NULL,
    pull_number INTEGER,
    tests TEXT NOT NULL DEFAULT '[]',
    action TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS queue_verdict_at ON queue_verdict (at);
  `;
