// What one thread of the forge has seen that another thread reads (docs/ARCHITECTURE.md, "Two threads"):
// the engine's observations of the pulls, the finishing pass's findings, the run holds of the last pass,
// the stale-ask sweep's answers. One row per kind and scope, replaced whole by the thread that makes it
// and adopted by the thread that reads it; a copy of memory, never the truth, so it is never read by a
// forge on one thread. Additive.
export default `
  CREATE TABLE engine_observation (
    kind  TEXT NOT NULL,
    scope TEXT NOT NULL,
    at    INTEGER NOT NULL,
    body  TEXT NOT NULL,
    PRIMARY KEY (kind, scope)
  ) WITHOUT ROWID;
  `;
