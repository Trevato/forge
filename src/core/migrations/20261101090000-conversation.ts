// A person's conversation with the forge, kept turn by turn (#7647): one per
// person, so talking to the forge never depends on a session that can stall.
export default `
  CREATE TABLE conversation (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL UNIQUE REFERENCES user(id) ON DELETE CASCADE,
    claude_session_id TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );
  CREATE TABLE conversation_turn (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('person','agent','tool','confirm')),
    text            TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX conversation_turn_by_conversation ON conversation_turn(conversation_id, id);
  `;
