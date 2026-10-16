// Requests counted by the hour (#2077): one row per hour, route pattern,
// method, status class (`2xx`…`5xx`), role and surface. Nothing writes it yet.
export default `
  CREATE TABLE usage_count (
    hour TEXT, pattern TEXT, method TEXT, status TEXT, role TEXT, surface TEXT,
    n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (hour, pattern, method, status, role, surface)
  ) WITHOUT ROWID;
  `;
