// 89 — a pull the crew parked (#1624) closes as parked, not done. The
// column carries it, and `close_reason` stays NULL: its CHECK cannot be
// widened in place, and NULL is never read as done by raw SQL.
// `closeReason` reads 'parked' from it.
export default `
  ALTER TABLE issue ADD COLUMN parked INTEGER NOT NULL DEFAULT 0;
  `;
