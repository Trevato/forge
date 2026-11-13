// One index of `event` that no statement needs (#12011, part of #11973): `event_repo` on
// (repo_id, id), 162 MB of the 4.6 GB file on production (2.4M rows, an entry each). The one
// statement that plans through it (the last close or reopen of an issue by number, in
// `core/done_on_main.ts`) plans through `event_repo_kind_number_at` without it, which names the
// repository, the kind and the number: `scripts/index-use.ts` planned with it dropped
// moves that statement and no other. Every other statement that names a repository walks one of
// the four indexes that lead with `repo_id` (`event_repo_seq`, `event_repo_kind_seq`,
// `event_repo_actor_at`, `event_repo_kind_number_at`), the lookup a deleted repository's cascade
// makes included. Each event written pays one entry fewer in ten. Additive: an old process plans
// the same statements without it.
export default `
  DROP INDEX IF EXISTS event_repo;
  `;
