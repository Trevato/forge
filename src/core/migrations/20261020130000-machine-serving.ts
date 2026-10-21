// Whether the forge still serves while its children work (#3319): on the
// `forge` target, the event loop's p99 lateness in ms over the step (and
// the worst 15-s point in a 5-min roll-up), and how many checks and crew
// runs were running then. Telemetry, not state: a lost row is a gap.
export default `
  ALTER TABLE machine_sample ADD COLUMN lag_ms REAL;
  ALTER TABLE machine_sample ADD COLUMN lag_ms_max REAL;
  ALTER TABLE machine_sample ADD COLUMN checks REAL;
  ALTER TABLE machine_sample ADD COLUMN agents REAL;
  `;
