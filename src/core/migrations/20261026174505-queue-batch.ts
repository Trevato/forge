// Each merge-queue batch's verdict (#6427): one row per candidate the queue
// judged, its bisection prefixes, re-checks and cut-off gates not counted
// (`checks/queue.ts`), so the red-batch rate outlives the process. Rows past
// a week are pruned by `keepBatch`. A new table.
export default `
  CREATE TABLE IF NOT EXISTS queue_batch (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    red INTEGER NOT NULL CHECK (red IN (0, 1)),
    finished_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS queue_batch_finished ON queue_batch (finished_at);
  `;
