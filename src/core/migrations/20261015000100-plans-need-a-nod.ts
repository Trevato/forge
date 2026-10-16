// plans need a nod (#1813): with the setting on, a plan is stored as
// one proposal (its ordered issues as JSON) and opens nothing until a
// person nods. Off is the default until a person can read and nod a stored proposal.
export default `
  ALTER TABLE repo ADD COLUMN plans_need_nod INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE plan_proposal (
    id         TEXT PRIMARY KEY,
    repo_id    TEXT NOT NULL,
    author_id  TEXT NOT NULL,
    title      TEXT NOT NULL,
    why        TEXT NOT NULL,
    issues     TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX plan_proposal_repo ON plan_proposal(repo_id, created_at);
  `;
