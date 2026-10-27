// What each merge-queue gate found (#6739, checks/gate_result.ts): its pulls,
// its state, why it went red, how many tests passed and failed, the failing
// tests by name with the first lines of their errors (`tests`, JSON, at most
// 20), and how long it took — so a red batch names what to fix, and a test
// red in two batches that share no pull reads as flaky. Pruned past a week
// as new rows are written. Additive.
export default `
  CREATE TABLE IF NOT EXISTS gate_result (
    id          TEXT PRIMARY KEY,
    repo_id     TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    run_id      TEXT NOT NULL,
    tip_oid     TEXT NOT NULL,
    pulls       TEXT NOT NULL DEFAULT '[]',
    state       TEXT NOT NULL,
    reason      TEXT,
    passed      INTEGER NOT NULL DEFAULT 0,
    failed      INTEGER NOT NULL DEFAULT 0,
    tests       TEXT NOT NULL DEFAULT '[]',
    started_at  TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS gate_result_repo ON gate_result (repo_id, id);
  CREATE INDEX IF NOT EXISTS gate_result_finished ON gate_result (finished_at);
  `;
