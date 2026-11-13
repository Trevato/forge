// A parent forge brokers the one-click connect for the forges it hosts: its OAuth application is registered
// for its own address, so it runs the authorize and the callback, and hands the person's token to the child
// once, for at most a minute, against a code only that child can redeem. `origin_broker` is that exchange in
// flight and nothing more: the parent's state is kept as a digest, the secrets are sealed, a spent or
// expired row is deleted, and the token is blanked the moment it is redeemed. Additive.
export default `
  CREATE TABLE IF NOT EXISTS origin_broker (
    id               TEXT PRIMARY KEY,
    child            TEXT NOT NULL,
    host             TEXT NOT NULL,
    kind             TEXT NOT NULL,
    api_url          TEXT NOT NULL,
    web_url          TEXT NOT NULL,
    software         TEXT NOT NULL DEFAULT '',
    client_id        TEXT NOT NULL,
    state_hash       TEXT,
    cookie_hash      TEXT NOT NULL,
    child_state_enc  TEXT NOT NULL,
    child_state_hash TEXT NOT NULL,
    challenge        TEXT NOT NULL,
    verifier_enc     TEXT NOT NULL,
    redirect_uri     TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','ready','spent')),
    code_hash        TEXT,
    token_enc        TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at       TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS origin_broker_state ON origin_broker(state_hash);
  CREATE UNIQUE INDEX IF NOT EXISTS origin_broker_code ON origin_broker(code_hash);
  CREATE UNIQUE INDEX IF NOT EXISTS origin_broker_child_state ON origin_broker(child, child_state_hash);
  CREATE INDEX IF NOT EXISTS origin_broker_expires ON origin_broker(expires_at);
`;
