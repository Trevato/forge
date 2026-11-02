// Main verified after landing (#7786): its runs are checks in the `verify`
// and `verify-bisect` environments. The scheduler and /boards' Pipeline ask
// for a repository's newest ones; this keeps that a seek, not a walk of
// every check the repository ever ran.
export default `
  CREATE INDEX IF NOT EXISTS run_verify ON run(repo_id, env, id DESC);
  `;
