// A token the OAuth token endpoint minted is marked, so POST /oauth/revoke
// (RFC 7009, #8360) can end it and refuse every other kind: a personal token
// made in settings is not the harness's to revoke. Additive; tokens minted
// before this carry no mark and are ended in settings.
export default `
  CREATE TABLE oauth_token (
    token_id   TEXT PRIMARY KEY REFERENCES token(id) ON DELETE CASCADE,
    client_id  TEXT NOT NULL
  );
  `;
