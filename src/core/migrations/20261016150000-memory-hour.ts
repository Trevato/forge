// The forge's own memory, one row an hour (#2151, boards/memory.ts): the
// resident set (RSS) beside the JS heap, so RSS climbing while the heap
// stays flat shows as a native leak. A running sum and count give the mean;
// telemetry, not state — a lost row is a gap in a chart.
export default `
  CREATE TABLE memory_hour (
    hour       INTEGER PRIMARY KEY,
    samples    INTEGER NOT NULL,
    rss_sum    REAL NOT NULL,
    rss_max    REAL NOT NULL,
    heap_sum   REAL NOT NULL,
    heap_max   REAL NOT NULL
  );
  `;
