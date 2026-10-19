// A first-party beacon reports each page view's real load, LCP, INP, CLS and
// TTFB (#2711). No IP and no user agent string is kept: `visitor` is a hash
// under a salt that rotates daily, and yesterday's salt is deleted, so a
// visitor cannot be followed from one day to the next. A day holds at most a
// fixed number of rows (`DAY_MAX`), so strangers cannot grow the table. A metric the browser
// could not measure is NULL.
export default `
  CREATE TABLE page_vital (
    id      INTEGER PRIMARY KEY,
    day     TEXT NOT NULL,
    at      INTEGER NOT NULL,
    route   TEXT NOT NULL,
    visitor TEXT NOT NULL,
    ttfb    REAL,
    load    REAL,
    lcp     REAL,
    inp     REAL,
    cls     REAL NOT NULL
  );
  CREATE INDEX page_vital_day ON page_vital (day);
  CREATE TABLE vital_salt (
    day  TEXT PRIMARY KEY,
    salt TEXT NOT NULL
  );
  `;
