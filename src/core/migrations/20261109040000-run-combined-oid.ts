// The combined commit a kept fork's pull check ran on (#9932). The run stays
// keyed to the head (`commit_oid`) so head lookups and the merge gate find it;
// this says what it tested. Empty for any other run and for runs before.
export default `
  ALTER TABLE run ADD COLUMN combined_oid TEXT NOT NULL DEFAULT '';
  `;
