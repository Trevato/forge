// The apps shelf asks for each repository's newest agent run (#8379). A
// window over every agent run of every repository on the shelf cost
// 320–400 ms; this index makes each repository's newest one a seek.
// Additive: an index build, no table rewrite.
export default `
  CREATE INDEX IF NOT EXISTS run_agent_latest ON run(repo_id, created_at DESC, id DESC) WHERE kind = 'agent';
  `;
