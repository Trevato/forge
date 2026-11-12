// The week's readings (#8910): the share of the provider's week still free,
// stored as the crew reads it, so the burn is the change in the measured
// percent over time and never dollars turned into percent. Additive.
export default `
  CREATE TABLE week_reading (
    scope TEXT NOT NULL,
    at TEXT NOT NULL,
    free_pct REAL NOT NULL,
    PRIMARY KEY (scope, at)
  ) WITHOUT ROWID;
  `;
