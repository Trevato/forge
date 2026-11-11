// Disk health readings, one row per machine and device and time (#10465), and
// the machine's own CPU and memory. A behind-controller device keeps a row with
// no reading. Additive.
export default `
  CREATE TABLE disk_reading (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    machine  TEXT NOT NULL,
    device   TEXT NOT NULL,
    taken_at INTEGER NOT NULL,
    kind     TEXT NOT NULL CHECK (kind IN ('nvme','behind-controller')),
    reading  TEXT
  );
  CREATE INDEX disk_reading_by_device ON disk_reading (machine, device, taken_at);
  CREATE TABLE machine_inventory (
    machine      TEXT PRIMARY KEY,
    cpu          TEXT NOT NULL,
    memory_bytes INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  `;
