// 75 — a limb's place among its siblings (#1064), set by a person. `parent_id`
// is the issue whose limbs these are, or '' for the top of the plan.
export default `
  CREATE TABLE limb_place (
    repo_id   TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    parent_id TEXT NOT NULL,
    issue_id  TEXT NOT NULL,
    place     INTEGER NOT NULL,
    PRIMARY KEY (repo_id, parent_id, issue_id)
  );
  `;
