// 77 — OpenID Connect over the same grant (#1459): the nonce and OIDC
// scopes a consent carried, the signing keys (current and previous), and
// which access tokens came from an OpenID grant, for /oauth/userinfo.
export default `
  ALTER TABLE oauth_code ADD COLUMN oidc_scopes TEXT NOT NULL DEFAULT '';
  ALTER TABLE oauth_code ADD COLUMN nonce TEXT NOT NULL DEFAULT '';
  CREATE TABLE oidc_key (
    kid         TEXT PRIMARY KEY,
    private_jwk TEXT NOT NULL,
    public_jwk  TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE oidc_token (
    token_id TEXT PRIMARY KEY REFERENCES token(id) ON DELETE CASCADE,
    scopes   TEXT NOT NULL
  );
  `;
