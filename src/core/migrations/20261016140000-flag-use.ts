// Flag reads counted by the day (#1829): one row per UTC day, flag and the
// variant it answered (1 on, 0 off). Written in batches from memory.
export default `
  CREATE TABLE flag_use (
    day TEXT NOT NULL, flag TEXT NOT NULL, variant INTEGER NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, flag, variant)
  ) WITHOUT ROWID;
  `;
