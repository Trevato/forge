// One row per vendor call the forge makes or hands out (#2177, cloud/gate.ts):
// which account, for what purpose, how many bytes went out, when, and whether
// the gate allowed it. Indexed on `at` because the page lists today's rows and
// the pruning on write drops rows past 90 days. Never holds a token or a query.
export default `
  CREATE TABLE cloud_audit (
    id        INTEGER PRIMARY KEY,
    at        TEXT NOT NULL,
    provider  TEXT NOT NULL,
    account   TEXT NOT NULL,
    purpose   TEXT NOT NULL,
    target    TEXT NOT NULL DEFAULT '',
    bytes_out INTEGER NOT NULL DEFAULT 0,
    allowed   INTEGER NOT NULL
  );
  CREATE INDEX cloud_audit_at ON cloud_audit (at);
  `;
