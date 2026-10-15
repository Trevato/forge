// 35 — what a viewer did with a feed item: opened it, dwelled on it,
// dismissed it, muted its app. One row per act; the feed's affinity is
// these, counted with a decay. `item_id` is the feed's own id, and
// `repo_id`/`actor_id` are what the act says it was about, so a row
// outlives the event it named.
export default `
  CREATE TABLE interaction (
    id         TEXT PRIMARY KEY,
    viewer_id  TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    item_id    TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN
      ('opened','dwelled','steered','told','swiped','shipped','shared','dismissed','muted')),
    repo_id    TEXT REFERENCES repo(id) ON DELETE CASCADE,
    actor_id   TEXT REFERENCES user(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX interaction_viewer ON interaction(viewer_id, id);
  `;
