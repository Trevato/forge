// What the machine used, kept longer and smaller (#12007, system/retention_samples.ts):
// 15-s points for 48 h, 5-min roll-ups for 30 days, hourly roll-ups after. SQLite cannot
// widen a CHECK in place, so the table is copied into one whose step also allows 3600.
// Telemetry, not state.
export default `
  CREATE TABLE machine_sample_next (
    at               TEXT NOT NULL,
    step             INTEGER NOT NULL CHECK (step IN (15, 300, 3600)),
    target           TEXT NOT NULL,
    cpu_cores        REAL,
    cpu_cores_max    REAL,
    memory_bytes     REAL,
    memory_bytes_max REAL,
    load             REAL,
    celsius          REAL,
    celsius_max      REAL,
    lag_ms           REAL,
    lag_ms_max       REAL,
    checks           REAL,
    agents           REAL,
    PRIMARY KEY (step, at, target)
  ) WITHOUT ROWID;
  INSERT INTO machine_sample_next
    (at, step, target, cpu_cores, cpu_cores_max, memory_bytes, memory_bytes_max, load,
     celsius, celsius_max, lag_ms, lag_ms_max, checks, agents)
    SELECT at, step, target, cpu_cores, cpu_cores_max, memory_bytes, memory_bytes_max, load,
           celsius, celsius_max, lag_ms, lag_ms_max, checks, agents
      FROM machine_sample;
  DROP TABLE machine_sample;
  ALTER TABLE machine_sample_next RENAME TO machine_sample;
`;
