// The release tick's last heartbeat (#11507): one row, replaced each time the tick
// reports in — when, what it did (cut, skipped, failed) and why. Additive.
export default `
  CREATE TABLE keeper_beat (
    id      INTEGER PRIMARY KEY CHECK (id = 1),
    at      TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('cut', 'skipped', 'failed')),
    reason  TEXT NOT NULL
  );
  `;
