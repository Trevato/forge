// `route_hour` (#11477): per route pattern and hour, how many requests and their p50 and p95
// in ms, written once an hour by the performance watcher, kept 7 days. New table only. Additive.
export default `
  CREATE TABLE route_hour (
    route TEXT    NOT NULL,
    hour  INTEGER NOT NULL,
    n     INTEGER NOT NULL,
    p50   REAL    NOT NULL,
    p95   REAL    NOT NULL,
    PRIMARY KEY (route, hour)
  ) WITHOUT ROWID;
  CREATE INDEX route_hour_hour ON route_hour (hour);
  `;
