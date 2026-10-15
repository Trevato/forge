// 64 — the front page's settings beyond its picks (#767): how it ranks,
// as one value a site admin sets. Presentation, like the picks: no event.
export default `
  CREATE TABLE IF NOT EXISTS front_setting (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL,
    set_by TEXT REFERENCES user(id) ON DELETE SET NULL,
    set_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `;
