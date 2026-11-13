// The forge's one thread was blocked most of every minute (2026-11-13: 195 s of 300) by three
// questions asked of `run` (124k rows) on every look at health, flow and the terminal's home,
// each a full scan: how many checks are queued (`kernel/vitals.ts` readLane), which repositories
// have a verification (`flow/verified.ts` readVerified), and when the crew last started a run
// (`flow/alarm_idle_crew.ts`). Three indexes answer them from the index alone, and each query names its index
// (INDEXED BY), so the plan does not depend on statistics. Additive.
export default `
  CREATE INDEX IF NOT EXISTS run_kind_state ON run(kind, state);
  CREATE INDEX IF NOT EXISTS run_check_verify_repo ON run(repo_id) WHERE kind = 'check' AND env = 'verify';
  CREATE INDEX IF NOT EXISTS run_agent_last_start ON run(COALESCE(started_at, created_at)) WHERE kind = 'agent';
`;
