// 51 — the front page's picks (#686): what a site admin pinned to it, in
// order (the first one a stranger can read is featured), and what they
// hid from it. Presentation, like a user setting: no event.
export default `
  CREATE TABLE IF NOT EXISTS front_pick (
    repo_id  TEXT PRIMARY KEY REFERENCES repo(id) ON DELETE CASCADE,
    place    TEXT NOT NULL CHECK (place IN ('pinned','hidden')),
    position INTEGER NOT NULL DEFAULT 0,
    set_by   TEXT REFERENCES user(id) ON DELETE SET NULL,
    set_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `;
