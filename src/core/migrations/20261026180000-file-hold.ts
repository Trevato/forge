// One row per file an admin holds new work on (#6522, crew/file_holds.ts): the
// picker starts no build whose issue names the path, and the hold says who set
// it and when. Additive.
export default `
  CREATE TABLE file_hold (
    repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    path    TEXT NOT NULL,
    by      TEXT NOT NULL,
    at      TEXT NOT NULL,
    PRIMARY KEY (repo_id, path)
  );
  `;
