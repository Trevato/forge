// 23 — the look: a picture of an environment at a commit, at each of two
// widths, or the reason there is none. Rows go with the app.
export default `
  CREATE TABLE look (
    id         TEXT PRIMARY KEY,
    app_id     TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
    env        TEXT NOT NULL,
    commit_oid TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('phone','desktop')),
    path       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    error      TEXT,
    UNIQUE (app_id, env, commit_oid, kind)
  );
  `;
