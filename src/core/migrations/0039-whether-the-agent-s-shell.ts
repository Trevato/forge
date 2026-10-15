// 39 — whether the agent's shell was held to the sandbox policy, kept on
// the run so an old one can be read honestly. NULL: the run predates this,
// or is not an agent's. The note is why it was not, when it was not.
export default `
  ALTER TABLE run ADD COLUMN sandbox_enforced INTEGER;
  ALTER TABLE run ADD COLUMN sandbox_note TEXT NOT NULL DEFAULT '';
  `;
