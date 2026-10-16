// A consent that only signs someone in (OpenID scopes, no ro/rw) mints no
// token at the exchange; the code remembers it was asked that way.
export default `
  ALTER TABLE oauth_code ADD COLUMN signin_only INTEGER NOT NULL DEFAULT 0;
  `;
