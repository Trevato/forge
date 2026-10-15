// 79 — degraded history (#1296): one row per stretch a cause held, kept
// 30 days past its close (`kernel/degraded_history.ts`). Times are epoch ms;
// `closed_at` is null while the cause still holds, and at most one span
// per cause is open.
export default `
  CREATE TABLE degraded_span (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    cause     TEXT NOT NULL,
    sentence  TEXT NOT NULL,
    href      TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    closed_at INTEGER
  );
  CREATE UNIQUE INDEX degraded_span_open ON degraded_span(cause) WHERE closed_at IS NULL;
  CREATE INDEX degraded_span_closed ON degraded_span(closed_at) WHERE closed_at IS NOT NULL;
  `;
