// Evidence for telling a scraper from a reader (`perf/reads.ts`, `perf/network.ts`).
// `read_hour`: what was read from repositories, by the hour for 7 days: repository,
// ref (a branch or a commit), path, how many reads and how many were anonymous.
// No address is kept here. `network`: the forge's own database of who runs an
// address range (name, operator, country, abuse contact), filled by an admin, so no
// visitor address ever goes to a third party. New tables only. Additive.
export default `
  CREATE TABLE read_hour (
    hour      INTEGER NOT NULL,
    repo      TEXT    NOT NULL,
    ref       TEXT    NOT NULL,
    path      TEXT    NOT NULL,
    requests  INTEGER NOT NULL,
    anonymous INTEGER NOT NULL,
    PRIMARY KEY (hour, repo, ref, path)
  ) WITHOUT ROWID;
  CREATE TABLE network (
    cidr     TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    operator TEXT NOT NULL,
    country  TEXT NOT NULL,
    abuse    TEXT NOT NULL,
    source   TEXT NOT NULL,
    added_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  `;
