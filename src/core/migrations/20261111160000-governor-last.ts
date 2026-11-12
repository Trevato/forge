// The governor's last change of slot count (#11459), one row per repository, so the crew page can
// say what it did and why after a restart. A baseline is stored with from = to. Additive.
export default `
  CREATE TABLE governor_last (
    repo_id TEXT PRIMARY KEY,
    from_slots INTEGER NOT NULL,
    to_slots INTEGER NOT NULL,
    why TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL
  );
  `;
