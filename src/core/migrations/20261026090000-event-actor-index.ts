// The feed asks whether an agent wrote anything to a repository between two
// moments (`feed/quiet.ts`). Without this the answer for a run that wrote
// nothing reads every event the repository ever had. Additive.
export default `
  CREATE INDEX IF NOT EXISTS event_repo_actor_at ON event(repo_id, actor_id, created_at);
  `;
