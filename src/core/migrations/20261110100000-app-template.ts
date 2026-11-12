// Repositories a site admin has marked as app templates: New app offers them.
// One row per marked repository; the default (`trevato/app-template`) needs no
// row. Additive.
export default `
  CREATE TABLE app_template (
    repo_id   TEXT PRIMARY KEY REFERENCES repo(id) ON DELETE CASCADE,
    marked_by TEXT REFERENCES user(id) ON DELETE SET NULL,
    marked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `;
