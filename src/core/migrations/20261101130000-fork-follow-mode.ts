// How a plain fork follows its parent (#7796): tell me, or take updates. A
// fork with no row follows in the default mode.
export default `
  CREATE TABLE IF NOT EXISTS fork_follow (
    repo_id TEXT PRIMARY KEY REFERENCES repo(id) ON DELETE CASCADE,
    mode    TEXT NOT NULL CHECK (mode IN ('tell-me','take-updates'))
  );
  `;
