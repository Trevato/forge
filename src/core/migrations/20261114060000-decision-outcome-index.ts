// The feed and the asks list the newest decisions with a known outcome across every repository a
// reader may see: SQLite read each repository's decisions and sorted them all (92 ms on a copy of
// production, 28,490 decisions, 12,926 decided). A partial index in the order the list is wanted
// answers by walking it to the limit (0.4 ms); the read names it when the reader has many repositories
// (`INDEXED BY`), since for a few their own rows are fewer. Additive.
export default `
  CREATE INDEX IF NOT EXISTS decision_outcome_at ON decision(outcome_at DESC, id DESC) WHERE outcome IS NOT NULL;
`;
