// A test `ping` belongs to its own row, not to the repository's event log
// (#8006). A delivery must name an event, and a roll keeps the old release
// reading `webhook_delivery`, so the ping gets a table of its own beside it
// rather than a rebuilt delivery table: nothing the old release reads changes.
export default `
  CREATE TABLE IF NOT EXISTS webhook_ping (
    id          TEXT PRIMARY KEY,
    webhook_id  TEXT NOT NULL REFERENCES webhook(id) ON DELETE CASCADE,
    state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ok','failed')),
    attempts    INTEGER NOT NULL DEFAULT 0,
    next_try_at TEXT,
    last_status INTEGER,
    last_error  TEXT,
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ping_due ON webhook_ping(state, next_try_at);
  CREATE INDEX IF NOT EXISTS ping_hook ON webhook_ping(webhook_id, created_at);
  `;
