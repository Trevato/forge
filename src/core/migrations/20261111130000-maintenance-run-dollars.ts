// A maintenance duty's daily budget (#11206): what a run cost, in dollars, so the runner can
// stop a duty that has spent its day's allowance. Additive: one column.
export default `
  ALTER TABLE maintenance_run ADD COLUMN dollars REAL NOT NULL DEFAULT 0;
  `;
