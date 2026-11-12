// Why an agent run ran on the model it did: its agent's own, or an escalation
// to Opus by need (#7570).
export default `
  ALTER TABLE run ADD COLUMN model_reason TEXT NOT NULL DEFAULT '';
  `;
