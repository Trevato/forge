// 24 — a variable has a scope: every environment, production only, or
// previews only, so a preview can carry a test key where production
// carries the live one. The scope joins the key, which SQLite cannot add
// to a primary key in place, so the table is rebuilt; every row that
// existed meant "everywhere" and still does.
export default `
  CREATE TABLE app_env_scoped (
    app_id     TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    scope      TEXT NOT NULL DEFAULT 'all'
               CHECK (scope IN ('all','production','preview')),
    value_enc  TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (app_id, name, scope)
  );
  INSERT INTO app_env_scoped (app_id, name, scope, value_enc, created_at, updated_at)
    SELECT app_id, name, 'all', value_enc, created_at, updated_at FROM app_env;
  DROP TABLE app_env;
  ALTER TABLE app_env_scoped RENAME TO app_env;
  `;
