// A panel on /boards can be pinned to its owner's home (#2741). A pin is the
// owner, the board's slug and the panel's title; `pos` is the owner's order.
// Deleting the owner deletes their pins. A pin whose board or panel has since
// gone is kept and simply not drawn.
export default `
  CREATE TABLE board_pin (
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    slug    TEXT NOT NULL,
    title   TEXT NOT NULL,
    pos     INTEGER NOT NULL,
    PRIMARY KEY (user_id, slug, title)
  );
  CREATE INDEX board_pin_order ON board_pin (user_id, pos);
  `;
