// A like is one row per person and post (#7751): pressing again deletes it.
// A table of its own, so `interaction`'s CHECK is left alone and the
// migration only adds. `feed_like_item` counts a post's likes without
// reading anyone's history.
export default `
  CREATE TABLE feed_like (
    viewer_id  TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    item_id    TEXT NOT NULL,
    repo_id    TEXT REFERENCES repo(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (viewer_id, item_id)
  );
  CREATE INDEX feed_like_item ON feed_like(item_id);
  `;
