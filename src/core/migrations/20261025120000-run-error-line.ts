// The first error line of a failed run's log and its place there, kept with
// the run as it finishes so the feed never opens a log. A log line is for
// the repository's writers and crew; it lives here, never on the public
// event. Additive; empty on every run before this column.
export default `
  ALTER TABLE run ADD COLUMN error_line TEXT NOT NULL DEFAULT '';
  ALTER TABLE run ADD COLUMN error_at INTEGER NOT NULL DEFAULT 0;
  `;
