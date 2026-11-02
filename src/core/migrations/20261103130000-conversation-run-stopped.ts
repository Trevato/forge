// A /talk turn the person stopped is marked `stopped` (#8860), so the failure
// count stays what went wrong. Additive across a roll: the state check cannot
// be widened without rebuilding the table, and a release still in play reads
// `state`, so a stopped turn keeps state `failed` and this flag says it was a
// choice. Counts of failures leave `stopped = 1` out.
export default `
  ALTER TABLE conversation_run ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0;
  `;
