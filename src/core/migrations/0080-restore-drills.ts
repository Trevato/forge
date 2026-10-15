// 80 — restore drills (#1668): one row per run of `snapshot/drill.ts`,
// kept so the Backups page can show the last. `at` is an ISO time.
export default `
  CREATE TABLE drill (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    at           TEXT NOT NULL,
    snapshot_id  TEXT,
    ms           INTEGER NOT NULL,
    repositories INTEGER NOT NULL,
    issues       INTEGER NOT NULL,
    verdict      TEXT NOT NULL CHECK (verdict IN ('green', 'red')),
    failed_step  TEXT,
    reason       TEXT
  );
  `;
