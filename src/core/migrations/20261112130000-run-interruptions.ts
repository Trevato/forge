// How many times the host cut a run's task off and it was queued again (#11693): a count kept as
// data, so no one parses a summary to learn it. Each queued-again run carries its parent's count + 1.
// New column with a default. Additive. No backfill: a run in flight at deploy time starts from 0 and
// so gets at most one more try than the limit, which is harmless.
export default `
  ALTER TABLE run ADD COLUMN interruptions INTEGER NOT NULL DEFAULT 0;
  `;
