// Without statistics SQLite takes `run_kind_state` for any question that names a kind, and reads
// every run of that kind: the live count (28 ms), today's spend (22 ms) and the agents working on a
// repository (39 ms) each did, many times a minute, and the step statistics' five reads of a week's
// finished runs took 190 ms. Today's spend gets its covering index, and the finished runs one that
// holds every column the step statistics and the flow's outflow read; the three queries that named
// a kind now name the index (`INDEXED BY`, so the plan never depends on statistics). Additive.
export default `
  CREATE INDEX IF NOT EXISTS run_agent_cost ON run(created_at, cost_usd) WHERE kind = 'agent';
  CREATE INDEX IF NOT EXISTS run_finished_cov ON run(kind, finished_at, state, started_at, issue_id, env, reason, repo_id) WHERE finished_at IS NOT NULL;
`;
