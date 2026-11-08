// A known security advisory for the version a repository pins (#9590): the
// radar's last read keeps the advisory's one-line summary beside the newest
// release, "" when none is known. Additive.
export default `
  ALTER TABLE dep_latest ADD COLUMN advisory TEXT NOT NULL DEFAULT '';
  `;
