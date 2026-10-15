// 29 — a third width: thumb, a picture taken small for a slot that only
// ever showed one small, instead of a full phone or desktop picture
// squeezed into it. SQLite's CHECK cannot be altered in place, so the
// table is rebuilt; every row already there keeps its id and content.
export default `
  CREATE TABLE look_new (
    id         TEXT PRIMARY KEY,
    app_id     TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
    env        TEXT NOT NULL,
    commit_oid TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('phone','desktop','thumb')),
    path       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    error      TEXT,
    UNIQUE (app_id, env, commit_oid, kind)
  );
  INSERT INTO look_new SELECT * FROM look;
  DROP TABLE look;
  ALTER TABLE look_new RENAME TO look;
  `;
