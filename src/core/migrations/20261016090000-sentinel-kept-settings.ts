// A setting a person kept on purpose (#2001): the value and its
// `forge_setting.updated_at` when its finding was closed or explained, so the
// sentinel reports it again only when the value changes.
export default `
  CREATE TABLE IF NOT EXISTS sentinel_kept (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    kept_at    TEXT NOT NULL
  );
  `;
