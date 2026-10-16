// Sign in with the parent forge (#748, core/federation.ts): the client id this
// forge was given at its parent, a sign-in in flight (state kept only as a
// hash), and which local account a parent's `sub` is.
export default `
  CREATE TABLE rp_client (
    issuer       TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    client_id    TEXT NOT NULL,
    PRIMARY KEY (issuer, redirect_uri)
  ) WITHOUT ROWID;
  CREATE TABLE rp_login (
    state_hash   TEXT PRIMARY KEY,
    verifier     TEXT NOT NULL,
    nonce        TEXT NOT NULL,
    issuer       TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    expires_at   INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE federated_identity (
    issuer  TEXT NOT NULL,
    sub     TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    PRIMARY KEY (issuer, sub)
  ) WITHOUT ROWID;
`;
