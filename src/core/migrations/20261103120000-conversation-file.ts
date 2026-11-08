// What a person attached to a /talk message (#8820): the file's bytes live
// under FORGE_APP_DATA/conversation-files, this row says whose they are, what
// they were checked to be, and which turn they went with. A row with no turn
// is chosen but not yet sent.
export default `
  CREATE TABLE conversation_file (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    turn_id         TEXT,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL,
    size            INTEGER NOT NULL,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX conversation_file_by_conversation ON conversation_file(conversation_id, turn_id);
  `;
