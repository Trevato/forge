// 69 — an event's place in the outbox, as a number of its own (#932):
// replays resume by it, never by the id, which two processes in a roll
// can make out of order. It began as the rowid, which VACUUM may renumber
// on a table without an INTEGER PRIMARY KEY; this column it never
// touches. Every insert takes the next one, whoever writes it (the app or
// a migration's SQL), from the trigger: one writer at a time, so strictly
// increasing across every connection.
export default `
  ALTER TABLE event ADD COLUMN seq INTEGER;
  UPDATE event SET seq = rowid;
  CREATE UNIQUE INDEX IF NOT EXISTS event_seq ON event(seq);
  CREATE INDEX IF NOT EXISTS event_repo_seq ON event(repo_id, seq);
  CREATE TRIGGER IF NOT EXISTS event_seq_next AFTER INSERT ON event
  WHEN NEW.seq IS NULL
  BEGIN
    UPDATE event SET seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM event)
     WHERE rowid = NEW.rowid;
  END;
  `;
