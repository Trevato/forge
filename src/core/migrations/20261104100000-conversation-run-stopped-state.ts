// A /talk turn the person stopped is state `stopped` (#8972), no longer
// `failed` with a flag. SQLite cannot widen a CHECK in place, so the table is
// copied; turns already stopped are rewritten. The `stopped` column stays, set
// alongside, for a release still in play that counts by it.
export default `
  CREATE TEMP TABLE keep_run AS SELECT * FROM conversation_run;
  DROP TABLE conversation_run;
  CREATE TABLE conversation_run (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    state           TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','ok','failed','stopped')),
    session_id      TEXT NOT NULL DEFAULT '',
    subscription_id TEXT,
    prompt          TEXT NOT NULL,
    resumes         INTEGER NOT NULL DEFAULT 0,
    tokens_in       INTEGER NOT NULL DEFAULT 0,
    tokens_out      INTEGER NOT NULL DEFAULT 0,
    cost_usd        REAL NOT NULL DEFAULT 0,
    started_at      TEXT NOT NULL,
    finished_at     TEXT,
    resume_outcome  TEXT NOT NULL DEFAULT '',
    version         TEXT NOT NULL DEFAULT '',
    context_tokens  INTEGER NOT NULL DEFAULT 0,
    context_window  INTEGER NOT NULL DEFAULT 0,
    stopped         INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO conversation_run SELECT * FROM keep_run;
  UPDATE conversation_run SET state = 'stopped' WHERE stopped = 1;
  DROP TABLE keep_run;
  CREATE INDEX conversation_run_running ON conversation_run (state) WHERE state = 'running';
  CREATE INDEX conversation_run_spend ON conversation_run (user_id, started_at);
  `;
