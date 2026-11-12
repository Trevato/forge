// The efficiency watcher (#7558): one reading per cause per hour, and the one
// finding standing per cause. Additive. Both tables are small (a few causes,
// 24 rows a day each, pruned past 9 days) and read by primary key only.
export default `
  CREATE TABLE efficiency_sample (
    cause TEXT NOT NULL,
    hour TEXT NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (cause, hour)
  ) WITHOUT ROWID;
  CREATE TABLE efficiency_finding (
    cause TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL,
    last_bad TEXT NOT NULL
  ) WITHOUT ROWID;
  `;
