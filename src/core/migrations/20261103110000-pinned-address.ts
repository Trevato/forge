// The public IPv4 a pinned forge's droplet was read back with (#8745), so the
// forge can show the address it is served at. Additive; empty until it is read.
export default `
  ALTER TABLE pinned_forge ADD COLUMN address TEXT NOT NULL DEFAULT '';
  `;
