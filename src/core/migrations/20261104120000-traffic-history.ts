// Who used the forge, kept past a restart (`perf/traffic_store.ts`): each class
// of request by the minute (7 days) and by the hour (90), and each hour's largest
// repositories, user agents, address prefixes, countries and request signatures.
// No address, cookie or token: only a /16 or /32, and an estimate of how many.
export default `
  CREATE TABLE traffic_minute (
    minute    INTEGER NOT NULL,
    class     TEXT    NOT NULL,
    requests  INTEGER NOT NULL,
    ms        INTEGER NOT NULL,
    refused   INTEGER NOT NULL,
    addresses INTEGER NOT NULL,
    PRIMARY KEY (minute, class)
  ) WITHOUT ROWID;
  CREATE TABLE traffic_hour (
    hour      INTEGER NOT NULL,
    class     TEXT    NOT NULL,
    requests  INTEGER NOT NULL,
    ms        INTEGER NOT NULL,
    refused   INTEGER NOT NULL,
    addresses INTEGER NOT NULL,
    PRIMARY KEY (hour, class)
  ) WITHOUT ROWID;
  CREATE TABLE traffic_top (
    hour      INTEGER NOT NULL,
    kind      TEXT    NOT NULL,
    key       TEXT    NOT NULL,
    requests  INTEGER NOT NULL,
    ms        INTEGER NOT NULL,
    anonymous INTEGER NOT NULL,
    PRIMARY KEY (hour, kind, key)
  ) WITHOUT ROWID;
  `;
