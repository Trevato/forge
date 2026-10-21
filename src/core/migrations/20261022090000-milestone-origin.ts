// A milestone carried from an origin (#3829, `origins/milestones.ts`): the
// origin's own number kept beside the issue that stands for it, so carrying
// twice finds it instead of making another, and the due date the origin
// gave it. Additive.
export default `
  CREATE TABLE IF NOT EXISTS milestone_origin (
    repo_id       TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    origin_number INTEGER NOT NULL,
    issue_id      TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    due_on        TEXT,
    PRIMARY KEY (repo_id, origin_number)
  );
  `;
