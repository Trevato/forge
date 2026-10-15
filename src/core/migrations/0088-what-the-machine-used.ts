// 88 — what the machine used (#1576, boards/ring.ts): the forge pod,
// each cell and the node, every 15 s for a day and as 5-min mean and max
// for 30 days. Telemetry, not state: a lost row is a gap in a chart.
export default `
  CREATE TABLE machine_sample (
    at               TEXT NOT NULL,
    step             INTEGER NOT NULL CHECK (step IN (15, 300)),
    target           TEXT NOT NULL,
    cpu_cores        REAL,
    cpu_cores_max    REAL,
    memory_bytes     REAL,
    memory_bytes_max REAL,
    load             REAL,
    PRIMARY KEY (step, at, target)
  ) WITHOUT ROWID;
  `;
