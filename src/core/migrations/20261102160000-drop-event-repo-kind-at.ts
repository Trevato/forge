// A forge that booted between 2295ecb2 and c51fb207 applied the first text of
// 20261102040000, `event_repo_kind_at ON event(repo_id, kind, created_at)`,
// before it was edited into the partial `event_repo_pull_closed_at` (#8353).
// No query names it, and the planner may steer `event` lookups onto it.
// A no-op everywhere else. Additive.
export default `
  DROP INDEX IF EXISTS event_repo_kind_at;
  `;
