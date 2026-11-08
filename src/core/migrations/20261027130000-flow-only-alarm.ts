// When a flow alarm last stood while a repository's FLOW ONLY switch was on
// (#6395), epoch ms: 24 h after it the forge turns the switch off itself.
export default `
  CREATE TABLE flow_only_watch (
    repo_id TEXT PRIMARY KEY REFERENCES repo(id) ON DELETE CASCADE,
    alarm_at INTEGER NOT NULL
  );
`;
