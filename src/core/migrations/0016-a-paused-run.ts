// 16 — a paused run.
//
// A run the provider turned away (a rate limit, a usage window) is
// queued again for a moment after the limit lifts, and counts how many
// times that has happened to one task, so a limit that never lifts is
// not waited on forever.
export default `
  ALTER TABLE run ADD COLUMN not_before TEXT;
  ALTER TABLE run ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
  `;
