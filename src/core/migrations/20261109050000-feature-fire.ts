// The last time the forge called an absorbed app's scheduled tool, and how it
// went (`apps/feature_schedule.ts`): one row per (app, tool), replaced on each
// fire. `error` is the sentence on a failure, null on success. Additive.
export default `
  CREATE TABLE feature_fire (
    app_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    at INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT,
    duration_ms INTEGER NOT NULL,
    PRIMARY KEY (app_id, tool)
  ) WITHOUT ROWID;
  `;
