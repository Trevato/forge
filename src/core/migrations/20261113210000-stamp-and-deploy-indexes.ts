// Covering indexes for what the forge's one thread asked of `issue` and `run` on every write
// (2026-11-13, measured on a 4.5 GB copy of production): the plan stamp (`core/milestones.ts`
// readStamp) read five whole-repository aggregates each time anything changed, 115 ms for the
// busiest repository, and an app's first-times (`apps/golden_path.ts`) took 63 ms. Each index
// holds exactly the columns its query reads, so no table row is touched: 115 to 36 ms, 63 to
// 3 ms, 12 to 0 ms. Additive.
export default `
  CREATE INDEX IF NOT EXISTS issue_stamp ON issue(repo_id, id, updated_at, closed_at, state, sealed, parked, close_reason, assignee_id, title);
  CREATE INDEX IF NOT EXISTS run_agent_stamp ON run(repo_id, state, cost_usd, started_at, finished_at) WHERE kind = 'agent';
  CREATE INDEX IF NOT EXISTS run_deploy_serving ON run(repo_id, env, serving_at, created_at) WHERE kind = 'deploy' AND serving_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS run_live ON run(serving_at) WHERE kind = 'deploy' AND env = 'production' AND serving_at IS NOT NULL;
`;
