// 84 — placements (#652): where the planner put each thought. One row per
// thought, written once; the thought itself stays as typed. `placed` is a
// JSON list of what was done (opened, amended, deferred, superseded).
export default `
  CREATE TABLE placement (
    thought_id TEXT PRIMARY KEY,
    kind       TEXT NOT NULL CHECK (kind IN ('work', 'amendment', 'vision', 'decision', 'reversal')),
    placed     TEXT NOT NULL,
    reply      TEXT NOT NULL,
    question   INTEGER NOT NULL DEFAULT 0,
    decided_by TEXT NOT NULL,
    placed_at  TEXT NOT NULL
  );
  `;
