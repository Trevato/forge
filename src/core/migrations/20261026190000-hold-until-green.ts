// A hold set "until green" (#6495, core/holds.ts): the forge lets it go when
// a check passes on the pull's head. 0 is a plain hold, which is every hold
// there is today. Additive.
export default `
  ALTER TABLE pull_hold ADD COLUMN until_green INTEGER NOT NULL DEFAULT 0;
  `;
