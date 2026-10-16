// The restore drill counts users, pulls and apps too (#2145). Drills that ran
// before this keep 0, which the Backups line shows as it was recorded.
export default `
  ALTER TABLE drill ADD COLUMN users INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE drill ADD COLUMN pulls INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE drill ADD COLUMN apps INTEGER NOT NULL DEFAULT 0;
  `;
