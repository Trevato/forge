// The release tick's heartbeats (#11794): the last 50 ticks, not only the last,
// so a quiet six hours can be told from a dead keeper. keeper_beat holds one row
// by CHECK, and rebuilding it would not be additive across a roll, so the history
// is its own table, seeded with that row; keeper_beat stays for the release still
// in play and is read by nothing newer; #11833 retires it.
export default `
  CREATE TABLE keeper_beat_tick (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('cut', 'skipped', 'failed')),
    reason  TEXT NOT NULL
  );
  INSERT INTO keeper_beat_tick (at, outcome, reason) SELECT at, outcome, reason FROM keeper_beat;
  `;
