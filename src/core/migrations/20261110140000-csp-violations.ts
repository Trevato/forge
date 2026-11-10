// Content-Security-Policy violations browsers report (#10759): one count per
// UTC day, directive, blocked host and page path. Bounded per day by
// `recordViolation` (src/http/csp_report.ts); the primary key leads with
// `day`, so the week's read and the prune walk it. Additive.
export default `
  CREATE TABLE csp_violation (
    day       TEXT NOT NULL,
    directive TEXT NOT NULL,
    blocked   TEXT NOT NULL,
    path      TEXT NOT NULL,
    n         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, directive, blocked, path)
  ) WITHOUT ROWID;
  `;
