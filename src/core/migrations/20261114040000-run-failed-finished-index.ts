// The forge view (every few seconds, for every reader that draws it) asked two things of `run` that
// SQLite planned through an index that reads far more than they need: whether the budget killed a run
// today scanned a covering index of every finished run (18 ms), and when each open pull was last
// reviewed took the kind index and read every agent run (50 ms). The first gets the narrow index that
// answers from its own order (0.2 ms); the second already has one (`run_review_attempts`) and now names
// it (`INDEXED BY`, so the plan never depends on statistics: 0.05 ms). Additive.
export default `
  CREATE INDEX IF NOT EXISTS run_failed_finished ON run(finished_at) WHERE state = 'failed';
`;
