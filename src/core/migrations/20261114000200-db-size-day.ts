// The database file's size, one reading a UTC day (#12010), so /system and the vitals can say how
// fast it grows. `src/system/db_size.ts` writes the first reading of each day and keeps 60 days;
// every read takes all of them (at most 60 rows), so the primary key is the only index.
export default `
  CREATE TABLE db_size_day (
    day   TEXT PRIMARY KEY,
    at    TEXT NOT NULL,
    bytes INTEGER NOT NULL
  ) WITHOUT ROWID;
`;
