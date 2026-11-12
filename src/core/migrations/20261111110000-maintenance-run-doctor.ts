// The batch doctor's acts (#7555) are `maintenance_run` rows (duty `batch-doctor`):
// the repository and pull they concern, the batch, the culprit pull, how the red
// was classed, what was done and the test output line it went on. Additive: columns only.
export default `
  ALTER TABLE maintenance_run ADD COLUMN repo_id TEXT;
  ALTER TABLE maintenance_run ADD COLUMN issue_id TEXT;
  ALTER TABLE maintenance_run ADD COLUMN batch TEXT NOT NULL DEFAULT '';
  ALTER TABLE maintenance_run ADD COLUMN culprit INTEGER;
  ALTER TABLE maintenance_run ADD COLUMN class TEXT NOT NULL DEFAULT '';
  ALTER TABLE maintenance_run ADD COLUMN action TEXT NOT NULL DEFAULT '';
  ALTER TABLE maintenance_run ADD COLUMN probe TEXT NOT NULL DEFAULT '';
  CREATE INDEX maintenance_run_repo ON maintenance_run (duty, repo_id, id);
  `;
