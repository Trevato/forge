// A followed upstream that came from the parent forge (an app a spawn sent down): how it
// follows (`mode`: tell-me proposes a pull, take-updates also fast-forwards when the default
// branch has nothing the upstream lacks), where the link came from (`via`: "parent", or "" for
// one a person set), the sealed credential that reads a private upstream (`credential_enc`,
// sealed with the forge's own key, never shown), and when its owner severed it (`severed_at`,
// so a repair never links it again), and how many commits of its own the default branch holds that
// the upstream lacks at the last check (`ahead`). A proposal token may be read-only: it fetches its one
// repository and does nothing else. Additive; every row from before reads as it did.
export default `
  ALTER TABLE repo_upstream ADD COLUMN mode TEXT NOT NULL DEFAULT 'tell-me';
  ALTER TABLE repo_upstream ADD COLUMN via TEXT NOT NULL DEFAULT '';
  ALTER TABLE repo_upstream ADD COLUMN credential_enc TEXT NOT NULL DEFAULT '';
  ALTER TABLE repo_upstream ADD COLUMN severed_at TEXT;
  ALTER TABLE repo_upstream ADD COLUMN ahead INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE proposal_token ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
  `;
