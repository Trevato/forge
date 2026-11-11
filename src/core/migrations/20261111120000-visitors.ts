// Who comes back (#11265): one row per visitor id (a first-party cookie id, or
// a "probable" salted hash of coarse request facts), and one per visit with the
// ordered paths. No address, no full user agent. Additive.
export default `
  CREATE TABLE visitor (
    id         TEXT    PRIMARY KEY,
    kind       TEXT    NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    days_seen  INTEGER NOT NULL,
    visits     INTEGER NOT NULL,
    first_ref  TEXT    NOT NULL,
    last_ref   TEXT    NOT NULL,
    step       INTEGER NOT NULL DEFAULT 0,
    forge      TEXT    NOT NULL DEFAULT '',
    linked_at  INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  CREATE INDEX visitor_last_seen ON visitor (last_seen);
  CREATE INDEX visitor_forge ON visitor (forge) WHERE forge <> '';
  CREATE TABLE visitor_visit (
    id        INTEGER PRIMARY KEY,
    visitor   TEXT    NOT NULL,
    day       TEXT    NOT NULL,
    started   INTEGER NOT NULL,
    last      INTEGER NOT NULL,
    entry_ref TEXT    NOT NULL,
    pages     TEXT    NOT NULL
  );
  CREATE INDEX visitor_visit_visitor ON visitor_visit (visitor, id);
  CREATE INDEX visitor_visit_day ON visitor_visit (day);
  CREATE TABLE visitor_salt (
    period INTEGER PRIMARY KEY,
    salt   TEXT    NOT NULL
  );
`;
