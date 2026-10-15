// 31 — a look knows which page it is of: `app.looks` in `forge.json` can
// name more than the home page. `page` defaults to `/`, so every row
// taken before this migration reads as exactly what it always was — a
// picture of the home page. The unique constraint gains `page` so two
// pages of one commit never collide; SQLite cannot alter a constraint in
// place, so the table is rebuilt, as `look_new` was before it.
export default `
  CREATE TABLE look_new (
    id         TEXT PRIMARY KEY,
    app_id     TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
    env        TEXT NOT NULL,
    commit_oid TEXT NOT NULL,
    page       TEXT NOT NULL DEFAULT '/',
    kind       TEXT NOT NULL CHECK (kind IN ('phone','desktop','thumb')),
    path       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    error      TEXT,
    UNIQUE (app_id, env, commit_oid, page, kind)
  );
  INSERT INTO look_new (id, app_id, env, commit_oid, kind, path, created_at, error)
    SELECT id, app_id, env, commit_oid, kind, path, created_at, error FROM look;
  DROP TABLE look;
  ALTER TABLE look_new RENAME TO look;
  `;
