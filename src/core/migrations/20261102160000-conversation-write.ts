// Each write the forge's agent sends is recorded before it runs (#8254): the
// tool, a hash of its arguments, and later what it answered. A turn the
// restart cut is resumed from a session that may not have heard how a write
// ended; the record lets the forge answer the same write again with what was
// done, instead of doing it twice. Only the hash is kept, never the arguments.
export default `
  CREATE TABLE conversation_write (
    id         TEXT PRIMARY KEY,
    via        TEXT NOT NULL,
    tool       TEXT NOT NULL,
    args_hash  TEXT NOT NULL,
    result     TEXT,
    resumed    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX conversation_write_via ON conversation_write (via, tool, args_hash);
  `;
