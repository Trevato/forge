// One agent turn of a person's conversation (#7651): the run that answers a
// message, with the session it resumes, what it spent and on which account.
// A row still `running` at boot is a turn the forge's restart cut short.
export default `
  CREATE TABLE conversation_run (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    state           TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','ok','failed')),
    session_id      TEXT NOT NULL DEFAULT '',
    subscription_id TEXT,
    prompt          TEXT NOT NULL,
    resumes         INTEGER NOT NULL DEFAULT 0,
    tokens_in       INTEGER NOT NULL DEFAULT 0,
    tokens_out      INTEGER NOT NULL DEFAULT 0,
    cost_usd        REAL NOT NULL DEFAULT 0,
    started_at      TEXT NOT NULL,
    finished_at     TEXT
  );
  CREATE INDEX conversation_run_running ON conversation_run (state) WHERE state = 'running';
  CREATE INDEX conversation_run_spend ON conversation_run (user_id, started_at);
  `;
