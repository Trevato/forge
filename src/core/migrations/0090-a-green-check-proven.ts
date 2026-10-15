// 90 — a green check's key and who proved it (#1795, checks/proven.ts):
// the same tree under the same gate is not run twice. A lost row is a
// check run again.
export default `
  CREATE TABLE check_proven (
    key       TEXT PRIMARY KEY,
    proven_by TEXT NOT NULL,
    at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ) WITHOUT ROWID;
  `;
