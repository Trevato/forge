// A like is a signal in the decision ledger (#10389): one row per act, never
// edited. `act` is `like` or `unlike`; taking a like back is a new row, not a
// deletion of history. `feed_like` stays the current state (kept in step in
// the same transaction) so counting a post's likes reads no history. Rows
// that already stand in `feed_like` become the first `like` rows. Additive.
export default `
  CREATE TABLE feed_signal (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    viewer_id  TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    item_id    TEXT NOT NULL,
    repo_id    TEXT REFERENCES repo(id) ON DELETE CASCADE,
    act        TEXT NOT NULL CHECK (act IN ('like','unlike')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX feed_signal_item ON feed_signal(item_id, seq);
  INSERT INTO feed_signal (viewer_id, item_id, repo_id, act, created_at)
    SELECT viewer_id, item_id, repo_id, 'like', created_at FROM feed_like ORDER BY created_at;
  `;
