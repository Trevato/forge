// The flow readers' indexes (#3693). `/boards`, `/system` and home read the
// pipeline and its throughput on every view; without these, each merged
// pull's "first production deploy since" walked every run of its repository,
// and each stage's outflow scanned the whole run table, and so did
// finding the pulls a bring-up-to-date run is working on; a ready ask's
// "no open pull from its crew branch" scanned every pull. Home's figures
// summed today's crew spend over every run and counted each day's visitors
// from the page views themselves. Additive.
export default `
  CREATE INDEX run_deploy_since ON run(repo_id, env, created_at) WHERE kind = 'deploy';
  CREATE INDEX run_kind_started ON run(kind, started_at) WHERE started_at IS NOT NULL;
  CREATE INDEX run_kind_finished ON run(kind, finished_at) WHERE finished_at IS NOT NULL;
  CREATE INDEX run_serving ON run(serving_at) WHERE serving_at IS NOT NULL;
  CREATE INDEX run_conflict ON run(issue_id, created_at) WHERE kind = 'agent' AND reason = 'conflict';
  CREATE INDEX run_agent_created ON run(created_at) WHERE kind = 'agent';
  CREATE INDEX pull_head_branch ON pull(head_branch);
  CREATE INDEX pull_merged ON pull(merged_at) WHERE merged_at IS NOT NULL;
  CREATE INDEX page_vital_day_visitor ON page_vital(day, visitor);
  CREATE INDEX page_vital_day_vitals ON page_vital(day, load, inp);
  CREATE INDEX session_seen ON session(last_seen_at, user_id);
  `;
