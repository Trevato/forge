// The release keeper times the stages it owns (#11839): how long the tree took to check out (build),
// to pass its preflight boot (proof) and to be started beside the live one and take the port (switch),
// each null when that release did not measure it. `hotfix` is the reason a person cut the release now,
// outside the spacing; empty for a cut on cadence. `keeper_now` is a person's standing request to cut at
// the next tick, one row, consumed by the cut. Additive: new nullable columns and a new table.
export default `
  ALTER TABLE keeper_release ADD COLUMN build_ms INTEGER;
  ALTER TABLE keeper_release ADD COLUMN proof_ms INTEGER;
  ALTER TABLE keeper_release ADD COLUMN switch_ms INTEGER;
  ALTER TABLE keeper_release ADD COLUMN hotfix TEXT NOT NULL DEFAULT '';
  CREATE TABLE IF NOT EXISTS keeper_now (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    reason TEXT NOT NULL,
    by TEXT NOT NULL,
    at TEXT NOT NULL
  );
`;
