// What a run reserved of its account's daily ceiling when it started
// (`core/account_ceiling.ts` `reserveCeiling`). While the run is queued or
// running, the part it has not spent yet counts against the day, so runs
// started together cannot each pass a ceiling only one of them fits in.
// Null is a run that reserved nothing (its account has no ceiling).
export default `
  ALTER TABLE run ADD COLUMN ceiling_reserved_usd REAL;
  `;
