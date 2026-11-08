// The clog watch survives a restart (#6524): the one standing clog (since
// when, the reasons that started it, quiet readings so far). The cleared
// note rides the event outbox as `clog.cleared`.
export default `
  CREATE TABLE IF NOT EXISTS clog_state (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    since         INTEGER NOT NULL,
    first_reasons TEXT NOT NULL,
    quiet         INTEGER NOT NULL DEFAULT 0
  );
  `;
