// A device on the owner's network (a LAN printer), declared by a forge admin.
// `probe_json`/`probed_at` keep the last answer so a page view inside the
// freshness window asks the printer nothing. Additive.
export default `
  CREATE TABLE device (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    kind       TEXT NOT NULL,
    url        TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    probe_json TEXT,
    probed_at  TEXT
  );
  `;
