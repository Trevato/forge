// 33 — where a repository's next tell comes from when nobody is typing:
// an Instagram account whose latest Reel's top comment becomes the crew's
// next tell, once a day at `at_utc`. The token is sealed under the forge's
// key, bound to the row; `last_media_id` is the Reel already told, so the
// same one is never told twice; `last_said` is the last run's sentence.
export default `
  CREATE TABLE prompt_source (
    id                 TEXT PRIMARY KEY,
    repo_id            TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    kind               TEXT NOT NULL,
    account            TEXT NOT NULL DEFAULT '',
    token_enc          TEXT NOT NULL,
    token_refreshed_at TEXT NOT NULL,
    at_utc             TEXT NOT NULL,
    created_by         TEXT REFERENCES user(id) ON DELETE SET NULL,
    created_at         TEXT NOT NULL,
    last_ran_at        TEXT,
    last_said          TEXT NOT NULL DEFAULT '',
    last_media_id      TEXT,
    last_issue_number  INTEGER
  );
  CREATE INDEX prompt_source_repo ON prompt_source(repo_id);
  `;
