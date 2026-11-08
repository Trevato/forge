// How a mirrored pull's check stands on its origin (#8965): the word the
// origin gave for one head, and when it was last asked. One row per pull,
// replaced as the origin's webhook or the poll brings news. Additive.
export default `
  CREATE TABLE origin_pull_check (
    issue_id   TEXT PRIMARY KEY REFERENCES issue(id) ON DELETE CASCADE,
    head_oid   TEXT NOT NULL,
    word       TEXT NOT NULL CHECK (word IN ('green','red','running','none')),
    checked_at TEXT NOT NULL
  );
  `;
