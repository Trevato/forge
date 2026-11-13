// Four questions the map, the runs list and its tag asked of `run` (124k rows) and `event` (2.4M)
// planned through an index that reads far more than they need, on the one thread that serves every
// page (measured on a copy of production, per question): the agents at work (48 ms), the repository's
// production deploys of the week (61 ms, a sort besides), a run list filtered by a rare state such as
// `running` (85 ms to find nothing, twice per request: the list and its tag) and whether a person
// answered a landed issue (175 ms). The first and the last now name an index that already exists
// (`INDEXED BY`, so the plan never depends on statistics: 0.06 ms and 0.1 ms); the other two get
// the narrow index that answers from its own order (1.3 ms and under 1 ms). Additive.
export default `
  CREATE INDEX IF NOT EXISTS run_repo_state ON run(repo_id, state, id DESC);
  CREATE INDEX IF NOT EXISTS run_deploy_live_at ON run(repo_id, COALESCE(serving_at, finished_at), id)
    WHERE kind = 'deploy' AND env = 'production' AND state = 'ok';
`;
