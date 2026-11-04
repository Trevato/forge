// Trusted sources (#8937): who, on which forge, until when, set by whom;
// where each pull from another forge came from; and the one switch that
// stops all folding in. Additive; the list starts empty and the owner fills it.
export default `
  CREATE TABLE trusted_source (
    id         TEXT PRIMARY KEY,
    host       TEXT NOT NULL,
    account    TEXT NOT NULL,
    until      TEXT NOT NULL,
    set_by     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    warned_at  TEXT,
    UNIQUE (host, account)
  );
  CREATE TABLE pull_source (
    pull_id     TEXT PRIMARY KEY,
    host        TEXT NOT NULL,
    account     TEXT NOT NULL,
    via         TEXT NOT NULL DEFAULT '',
    received_at TEXT NOT NULL
  );
  CREATE INDEX pull_source_by_source ON pull_source (host, account);
  CREATE TABLE fold_in_stop (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    by TEXT NOT NULL,
    at TEXT NOT NULL
  );
  `;
