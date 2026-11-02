// The forge's own agent talks to a person with a token minted for that
// person and marked `via` the conversation (#7649): an ordinary rw token plus
// one row. Its conversation keeps two marks, the person's newest words and
// the newest read of text fenced as data, and a write the fence held waits
// as a confirm the person answers. Marks are ids (monotonic), so two in one
// millisecond still order.
export default `
  CREATE TABLE via_token (
    token_id  TEXT PRIMARY KEY REFERENCES token(id) ON DELETE CASCADE,
    via       TEXT NOT NULL
  );

  CREATE TABLE conversation_fence (
    via         TEXT PRIMARY KEY,
    heard_mark  TEXT NOT NULL,
    words       TEXT NOT NULL,
    read_mark   TEXT
  );

  CREATE TABLE conversation_held (
    id          TEXT PRIMARY KEY,
    via         TEXT NOT NULL,
    user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    tool        TEXT NOT NULL,
    args        TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX conversation_held_via ON conversation_held(via, id);
  `;
