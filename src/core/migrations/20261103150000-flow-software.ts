// The software an origin runs, kept on the connect in flight (#8902): the
// callback reads it back instead of asking the origin again, so the token
// endpoint it uses is the one the connect began with. Empty for every flow
// that already exists. Additive.
export default `
  ALTER TABLE oauth_flow ADD COLUMN software TEXT NOT NULL DEFAULT '';
  `;
