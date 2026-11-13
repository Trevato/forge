// The history of an absorbed app's tool runs (#12043): the last 30 per tool, each with how it was
// started (`schedule`, `late`, `page`, `terminal`, `mcp`, or `skipped` for a day the forge missed),
// and `feature_schedule_seen`, the spec each scheduled tool had when the forge first looked at it,
// so a new or changed schedule counts from then and never fires at once. Additive.
export default `
  CREATE TABLE feature_run (
    app_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    at INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    error TEXT,
    duration_ms INTEGER NOT NULL,
    how TEXT NOT NULL
  );
  CREATE INDEX feature_run_by_tool ON feature_run (app_id, tool, at);
  CREATE TABLE feature_schedule_seen (
    app_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    spec TEXT NOT NULL,
    since INTEGER NOT NULL,
    PRIMARY KEY (app_id, tool)
  ) WITHOUT ROWID;
  `;
