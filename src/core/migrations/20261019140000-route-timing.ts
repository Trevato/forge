// Each route's time, kept as a histogram per hour (#2710): one row per hour,
// route pattern (never the raw path) and bucket, with how many requests fell
// in it and their summed microseconds. Pruned after 30 days.
export default `
  CREATE TABLE route_timing (
    hour    TEXT    NOT NULL,
    pattern TEXT    NOT NULL,
    bucket  INTEGER NOT NULL,
    n       INTEGER NOT NULL,
    sum_us  INTEGER NOT NULL,
    PRIMARY KEY (hour, pattern, bucket)
  ) WITHOUT ROWID;
  `;
