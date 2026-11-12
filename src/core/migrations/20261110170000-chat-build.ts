// A conversation that builds an app (#11010): the repository it builds, the
// branch each turn commits to, and the pull that gives that branch a preview.
// Versions are the branch's commits, so none are stored here.
export default `
  CREATE TABLE chat_build (
    conversation_id TEXT PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
    repo_id         TEXT NOT NULL,
    branch          TEXT NOT NULL,
    pull_number     INTEGER,
    published_at    TEXT,
    created_at      TEXT NOT NULL
  );
`;
