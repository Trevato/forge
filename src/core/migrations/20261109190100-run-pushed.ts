// Whether an agent run moved its branch. A follow-up on a red check that
// pushed nothing — the failure was not the pull's to fix — tried nothing, so
// it is no automatic try against the pull (rule 7, `automaticRunsSince`).
// Null for every run from before, which reads as a try, as it always did.
// Additive.
export default `
  ALTER TABLE run ADD COLUMN pushed INTEGER;
  `;
