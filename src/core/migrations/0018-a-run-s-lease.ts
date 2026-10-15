// 18 — a run's lease.
//
// The process working a run renews this every so often; a running run
// whose lease has gone stale was abandoned by a forge that died, or is
// still being finished by a forge that is on its way out beside a new
// one. Only the stale ones are failed on boot.
export default `
  ALTER TABLE run ADD COLUMN heartbeat_at TEXT;
  `;
