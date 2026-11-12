// Talk runs the captain (#11011): the owner's durable facts and decisions,
// loaded into every Talk session, and the routines that post into a thread.
// A routine is one row per person and kind; its last run is kept so a forge
// that was down runs it once on waking, never twice.
export default `
  CREATE TABLE talk_memory (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX talk_memory_by_person ON talk_memory(user_id, created_at);
  CREATE TABLE talk_routine (
    user_id         TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('checkin', 'friends', 'paper')),
    enabled         INTEGER NOT NULL DEFAULT 1,
    every_min       INTEGER NOT NULL DEFAULT 60,
    at_hour         INTEGER,
    last_at         TEXT,
    conversation_id TEXT,
    PRIMARY KEY (user_id, kind)
  );
  `;
