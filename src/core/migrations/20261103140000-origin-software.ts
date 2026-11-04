// The software an origin runs, when it is more than its kind says (#8900):
// `forge` for another forge, which speaks the Gitea dialect and is stored as
// a Gitea origin, so the one thing that tells them apart lives here. Empty for
// every origin that already exists. Additive.
export default `
  ALTER TABLE origin ADD COLUMN software TEXT NOT NULL DEFAULT '';
  `;
