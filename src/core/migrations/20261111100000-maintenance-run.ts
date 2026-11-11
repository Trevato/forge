// Maintenance runs (#11204): one row per run of a maintenance duty, with what
// it found, what it did and the probe behind each finding. Additive.
// The index `maintenance_run_duty` serves "when did this duty last start" and
// the pruning of a duty's old rows; the primary key serves the latest-first
// list. The example duty adds no index to `issue`: a new one there changes
// the planner's choice for the cold reads.
export default `
  CREATE TABLE maintenance_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    duty TEXT NOT NULL,
    started TEXT NOT NULL,
    finished TEXT NOT NULL,
    findings TEXT NOT NULL DEFAULT '[]',
    actions TEXT NOT NULL DEFAULT '[]',
    probes TEXT NOT NULL DEFAULT '[]',
    outcome TEXT NOT NULL
  );
  CREATE INDEX maintenance_run_duty ON maintenance_run (duty, id);
  `;
