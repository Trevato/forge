// Many conversations a person (#8814): the one-per-person UNIQUE goes, and a
// conversation gains a title and an archived mark. SQLite cannot drop a
// UNIQUE in place, so the table is copied; its turns and runs are held aside
// first (and the attachments, which hang off both) because dropping the parent
// would cascade them away.
export default `
  CREATE TEMP TABLE keep_turn AS SELECT * FROM conversation_turn ORDER BY rowid;
  CREATE TEMP TABLE keep_run AS SELECT * FROM conversation_run;
  CREATE TEMP TABLE keep_file AS SELECT * FROM conversation_file;
  CREATE TABLE conversation_next (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    claude_session_id TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    title             TEXT NOT NULL DEFAULT '',
    archived_at       TEXT
  );
  INSERT INTO conversation_next (id, user_id, claude_session_id, created_at, updated_at)
    SELECT id, user_id, claude_session_id, created_at, updated_at FROM conversation;
  DROP TABLE conversation;
  ALTER TABLE conversation_next RENAME TO conversation;
  CREATE INDEX conversation_by_person ON conversation (user_id, updated_at);
  INSERT INTO conversation_turn SELECT * FROM keep_turn ORDER BY rowid;
  INSERT INTO conversation_run SELECT * FROM keep_run;
  INSERT INTO conversation_file SELECT * FROM keep_file;
  DROP TABLE keep_file;
  DROP TABLE keep_turn;
  DROP TABLE keep_run;
  `;
