// `run_kind_state` (kind, state) was added to answer one question, how many checks are queued, and
// has since answered nothing else well: with no statistics (the forge never runs ANALYZE) SQLite
// takes it for every statement that names a kind and reads every run of that kind, even where the
// statement has an index of its own: 45 of the 271 statements that touch `run` planned through it,
// among them the map's runs at work (48 ms against 0.06), the newest run of each pull (128 ms
// against 0.8), the live deploy (73 ms against 0.01) and the forge view's review attempts (50 ms
// against 0.05), each fixed one at a time by naming the right index. The one question it was made
// for names `run_queued` now (a covering partial index of the queued runs), so the index goes and
// every statement plans through the index built for it, as it did before today. Additive: an old
// process plans the same statements without it.
export default `
  DROP INDEX IF EXISTS run_kind_state;
`;
