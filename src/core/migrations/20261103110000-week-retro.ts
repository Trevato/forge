// The week as the sprint (#8704): the projection the forge made when a weekly
// window opened, and the retrospective it wrote when that window closed,
// frozen once. A proposal in a retrospective is accepted at most once, by a
// person: `week_retro_taken` holds who and when.
export default `
  CREATE TABLE IF NOT EXISTS week_projection (
    repo_id  TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    week_end TEXT NOT NULL,
    body     TEXT NOT NULL,
    at       TEXT NOT NULL,
    PRIMARY KEY (repo_id, week_end)
  );
  CREATE TABLE IF NOT EXISTS week_retro (
    repo_id  TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    week_end TEXT NOT NULL,
    body     TEXT NOT NULL,
    at       TEXT NOT NULL,
    PRIMARY KEY (repo_id, week_end)
  );
  CREATE TABLE IF NOT EXISTS week_retro_taken (
    repo_id  TEXT NOT NULL,
    week_end TEXT NOT NULL,
    idx      INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    at       TEXT NOT NULL,
    PRIMARY KEY (repo_id, week_end, idx)
  );
  `;
