// 81 — thoughts (#1658): what a person typed, kept exactly, forever. One
// row per thought, appended and never changed: the triggers refuse an
// UPDATE or DELETE, and there is no foreign key so no cascade can remove
// one when an account goes. The author is an id, not a reference.
export default `
  CREATE TABLE thought (
    id          TEXT PRIMARY KEY,
    author      TEXT NOT NULL,
    text        TEXT NOT NULL,
    source      TEXT NOT NULL CHECK (source IN ('composer', 'api', 'mcp', 'share')),
    received_at TEXT NOT NULL
  );
  CREATE INDEX thought_author ON thought(author, received_at);
  CREATE TRIGGER thought_no_update BEFORE UPDATE ON thought
  BEGIN SELECT RAISE(ABORT, 'a thought is never changed'); END;
  CREATE TRIGGER thought_no_delete BEFORE DELETE ON thought
  BEGIN SELECT RAISE(ABORT, 'a thought is never deleted'); END;
  `;
