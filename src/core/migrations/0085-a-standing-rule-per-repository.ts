// 85 — a standing rule per repository (#1605): who answers the decisions
// it asks of its owner. \`me\` is what every repository did before.
export default `
  ALTER TABLE repo ADD COLUMN decisions_by TEXT NOT NULL DEFAULT 'me'
    CHECK (decisions_by IN ('me', 'decider', 'decider_tell'));
  `;
