// 9 — OAuth for origins. A pasted token is the fallback, not the front
// door: GitHub's device grant works from a terminal with no browser, and
// Forgejo's authorization code + PKCE works from any browser, including
// the phone in your pocket while the forge runs headless on a server.
//
// An OAuth access token here lives about an hour, so an origin now carries
// a refresh token and an expiry, and `needs_reauth` records the one
// unrecoverable outcome (`invalid_grant`) so a surface can say so instead
// of retrying forever. Both secrets are sealed with the data-dir key, bound
// to the origin's own id.
export default `
  ALTER TABLE origin ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'pat'
    CHECK (auth_kind IN ('pat','oauth'));
  ALTER TABLE origin ADD COLUMN refresh_token_enc TEXT NOT NULL DEFAULT '';
  ALTER TABLE origin ADD COLUMN expires_at TEXT;
  ALTER TABLE origin ADD COLUMN needs_reauth INTEGER NOT NULL DEFAULT 0;

  -- An OAuth application registered on one instance. GitHub's can come from
  -- the operator's environment (one client id serves every user); every
  -- Forgejo needs its own registration, so the user pastes a client id once
  -- per instance. The secret is optional: a public client uses PKCE alone.
  CREATE TABLE origin_app (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    kind              TEXT NOT NULL CHECK (kind IN ('github','forgejo','gitea')),
    api_url           TEXT NOT NULL,
    web_url           TEXT NOT NULL,
    client_id         TEXT NOT NULL,
    client_secret_enc TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (user_id, api_url)
  );

  -- A connect in flight. Device flows are polled by the forge; code flows
  -- wait for a redirect back. Both are bound to the user who started them and
  -- expire, so a stolen code or state is worthless to anyone else.
  CREATE TABLE oauth_flow (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    flow             TEXT NOT NULL CHECK (flow IN ('device','code')),
    kind             TEXT NOT NULL CHECK (kind IN ('github','forgejo','gitea')),
    api_url          TEXT NOT NULL,
    web_url          TEXT NOT NULL,
    client_id        TEXT NOT NULL,
    client_secret_enc TEXT NOT NULL DEFAULT '',
    -- code flow: the lookup key is a hash, so the callback state is never
    -- stored in a form an attacker with read access could replay.
    state_hash       TEXT,
    verifier_enc     TEXT NOT NULL DEFAULT '',
    redirect_uri     TEXT NOT NULL DEFAULT '',
    -- device flow: what the user is shown, and the secret half we poll with.
    device_code_enc  TEXT NOT NULL DEFAULT '',
    user_code        TEXT NOT NULL DEFAULT '',
    verification_uri TEXT NOT NULL DEFAULT '',
    interval_secs    INTEGER NOT NULL DEFAULT 5,
    status           TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','done','failed')),
    detail           TEXT NOT NULL DEFAULT '',
    origin_id        TEXT REFERENCES origin(id) ON DELETE SET NULL,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at       TEXT NOT NULL,
    last_poll_at     TEXT
  );
  CREATE UNIQUE INDEX oauth_flow_state ON oauth_flow(state_hash);
  CREATE INDEX oauth_flow_user ON oauth_flow(user_id, id);
  `;
