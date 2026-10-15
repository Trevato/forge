// 65 — a sealed issue (#621): a security report, and the pull that fixes
// it, seen only by people who can write the repository and its crew until
// a writer unseals it (`core/sealed.ts`).
export default `
  ALTER TABLE issue ADD COLUMN sealed INTEGER NOT NULL DEFAULT 0;
  -- The crew works a sealed report in a private repository of its own,
  -- read by the base's writers and crew only, so the fix is never in the
  -- base's git or a public fork's before it merges.
  ALTER TABLE repo ADD COLUMN sealed_for TEXT REFERENCES repo(id) ON DELETE CASCADE;
  `;
