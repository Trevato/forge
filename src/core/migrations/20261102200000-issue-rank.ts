// The owner's one ranked list (#8694): where an issue stands in "Next up",
// 1 at the top. One row per ranked issue; deleted when it closes or is sent
// to "Not now".
export default `
  CREATE TABLE IF NOT EXISTS issue_rank (
    issue_id TEXT PRIMARY KEY REFERENCES issue(id) ON DELETE CASCADE,
    pos      INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    at       TEXT NOT NULL
  );
  `;
