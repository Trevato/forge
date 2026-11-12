// A maintenance duty's on/off switch (#11205): paused by a person or by three errors in a row,
// with why and when. `from_run` is the newest run at the last resume: only later runs count toward three.
export default `
  CREATE TABLE maintenance_duty_state (
    duty TEXT PRIMARY KEY,
    paused INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    by TEXT NOT NULL DEFAULT '',
    since TEXT NOT NULL DEFAULT '',
    from_run INTEGER NOT NULL DEFAULT 0
  );
  `;
