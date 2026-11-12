// Where people come from and where they go (#9427, `perf/views_store.ts`): one
// row per page view the beacon reports, for the forge (scope `forge`) or an app
// (scope = its id). `visitor` is the daily-salted hash; no address, cookie or
// user agent is kept. Read by scope and time, so the index leads with both.
// `github_traffic` is GitHub's own repository traffic, which it keeps 14 days,
// pulled daily; `github_pull` is when each repository was last pulled.
// New tables only. Additive.
export default `
  CREATE TABLE traffic_view (
    id       INTEGER PRIMARY KEY,
    scope    TEXT    NOT NULL,
    day      TEXT    NOT NULL,
    at       INTEGER NOT NULL,
    visitor  TEXT    NOT NULL,
    path     TEXT    NOT NULL,
    ref_host TEXT    NOT NULL DEFAULT '',
    source   TEXT    NOT NULL DEFAULT '',
    medium   TEXT    NOT NULL DEFAULT '',
    campaign TEXT    NOT NULL DEFAULT '',
    out_host TEXT    NOT NULL DEFAULT '',
    scraper  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX traffic_view_scope_at ON traffic_view (scope, at);
  CREATE TABLE github_traffic (
    repo    TEXT    NOT NULL,
    day     TEXT    NOT NULL,
    kind    TEXT    NOT NULL CHECK (kind IN ('views', 'clones', 'referrers')),
    key     TEXT    NOT NULL,
    count   INTEGER NOT NULL,
    uniques INTEGER NOT NULL,
    PRIMARY KEY (repo, day, kind, key)
  ) WITHOUT ROWID;
  CREATE TABLE github_pull (
    repo      TEXT PRIMARY KEY,
    pulled_at INTEGER NOT NULL,
    error     TEXT
  ) WITHOUT ROWID;
  `;
