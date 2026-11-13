// Nine questions the forge asks every tick or look (which runs are running, what is queued per kind,
// how many checks wait, how many agents run, which checks have stopped beating, which run is next)
// each scanned the 124,000 runs, 23 to 37 ms apiece, 229 ms for the nine, because `state = 'running'`
// cannot use `run_queue`, whose predicate is `state IN ('queued','running')`. One tiny partial index
// per state, each holding only the rows in that state, answers them from the index: 229 ms to 0.2 ms
// on a copy of production. The decision list by kind and time gets its own. Additive.
export default `
  CREATE INDEX IF NOT EXISTS run_running ON run(kind, repo_id) WHERE state = 'running';
  CREATE INDEX IF NOT EXISTS run_queued ON run(kind, created_at, not_before, id) WHERE state = 'queued';
  CREATE INDEX IF NOT EXISTS decision_kind_created ON decision(kind, created_at);
`;
