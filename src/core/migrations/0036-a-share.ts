// 36 — a share: one item, one sender, one recipient. A share is delivered
// (it shows in the recipient's feed, boosted), queued (the recipient's
// daily budget is spent; it waits and decays) or dropped (it decayed).
// One row per item and recipient, ever: that is the dedupe. What the
// item was is kept as words, so the row outlives the event it named.
export default `
  CREATE TABLE share (
    id           TEXT PRIMARY KEY,
    item_id      TEXT NOT NULL,
    sender_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    recipient_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    repo_id      TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    link         TEXT NOT NULL,
    what         TEXT NOT NULL,
    state        TEXT NOT NULL CHECK (state IN ('delivered','queued','dropped')),
    created_at   TEXT NOT NULL,
    delivered_at TEXT,
    UNIQUE (item_id, recipient_id)
  );
  CREATE INDEX share_recipient ON share(recipient_id, state);
  CREATE INDEX share_sender ON share(sender_id, state);
  `;
