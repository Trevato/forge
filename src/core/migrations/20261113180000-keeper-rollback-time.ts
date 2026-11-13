// Undone in one step, under a minute (#11839, #11919): a rolled-back release keeps how long
// the rollback took, from the swap asked to the known-good tree serving. Null for a release
// that was not rolled back or not timed. Additive: one new nullable column.
export default `
  ALTER TABLE keeper_release ADD COLUMN rollback_ms INTEGER;
`;
