// A domain drill and its verdict (#1851, kernel/domain_drill.ts): every
// result is kept, green or red.
export default `
  CREATE TABLE domain_drill (
    id           TEXT PRIMARY KEY,
    domain       TEXT NOT NULL,
    run_by       TEXT NOT NULL,
    health       TEXT NOT NULL,
    board        TEXT NOT NULL,
    back_seconds INTEGER NOT NULL,
    green        INTEGER NOT NULL,
    why          TEXT NOT NULL,
    at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX domain_drill_domain ON domain_drill(domain, at);
  `;
