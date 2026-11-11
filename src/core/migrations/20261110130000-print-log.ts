// Each app's prints on a device are capped per day and logged (#10569).
// `daily_cap` is the owner's number for one grant (default 10 jobs a day);
// `print_job` is one row per job: app, device, pages, outcome and the UTC day,
// kept with the device. Additive.
export default `
  ALTER TABLE device_grant ADD COLUMN daily_cap INTEGER NOT NULL DEFAULT 10;
  CREATE TABLE print_job (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    app_id    TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
    pages     INTEGER NOT NULL DEFAULT 0,
    outcome   TEXT NOT NULL,
    day       TEXT NOT NULL,
    at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX print_job_day ON print_job (device_id, app_id, day);
  `;
