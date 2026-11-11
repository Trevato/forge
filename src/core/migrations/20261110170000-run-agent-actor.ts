// A team's coordination figures read each member's agent runs since a week
// ago (#572), and the issues those members opened; without these indexes
// each read scanned every run, or every issue, on the forge.
// Additive: index builds, no table rewrite.
export default `
  CREATE INDEX IF NOT EXISTS run_agent_actor ON run(actor_id, finished_at) WHERE kind = 'agent';
  CREATE INDEX IF NOT EXISTS issue_author ON issue(author_id);
  `;
