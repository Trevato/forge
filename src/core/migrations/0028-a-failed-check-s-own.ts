// 28 — a failed check's own detail: the pass/fail counts and the first
// few failing names, recognised once from a `bun test` tail as the run
// finishes (`checks/bun-test.ts`) and stored as JSON beside the run, so a
// page that shows it never re-parses a log. Empty when the run passed or
// its output was not recognised — the studio then says exactly what it
// said before this column existed.
export default `
  ALTER TABLE run ADD COLUMN check_detail TEXT NOT NULL DEFAULT '';
  `;
