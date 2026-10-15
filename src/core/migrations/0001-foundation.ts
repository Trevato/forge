// 1 — foundation: users, sessions, tokens, repos, events, webhooks
export default `
  CREATE TABLE user (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name  TEXT NOT NULL DEFAULT '',
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE session (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at  TEXT NOT NULL
  );
  CREATE INDEX session_user ON session(user_id);

  CREATE TABLE token (
    id          TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,
    user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    scope       TEXT NOT NULL CHECK (scope IN ('ro','rw','admin')),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_used_at TEXT
  );
  CREATE INDEX token_user ON token(user_id);

  CREATE TABLE repo (
    id             TEXT PRIMARY KEY,
    owner_id       TEXT NOT NULL REFERENCES user(id),
    name           TEXT NOT NULL,
    visibility     TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public','private')),
    description    TEXT NOT NULL DEFAULT '',
    default_branch TEXT NOT NULL DEFAULT 'main',
    protect_default INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (owner_id, name COLLATE NOCASE)
  );

  CREATE TABLE event (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    repo_id    TEXT REFERENCES repo(id) ON DELETE CASCADE,
    actor_id   TEXT REFERENCES user(id),
    payload    TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX event_repo ON event(repo_id, id);
  CREATE INDEX event_kind ON event(kind, id);

  CREATE TABLE webhook (
    id           TEXT PRIMARY KEY,
    repo_id      TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    url          TEXT NOT NULL,
    secret       TEXT NOT NULL DEFAULT '',
    kinds        TEXT NOT NULL DEFAULT '*',
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE webhook_delivery (
    id          TEXT PRIMARY KEY,
    webhook_id  TEXT NOT NULL REFERENCES webhook(id) ON DELETE CASCADE,
    event_id    TEXT NOT NULL REFERENCES event(id) ON DELETE CASCADE,
    state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ok','failed')),
    attempts    INTEGER NOT NULL DEFAULT 0,
    next_try_at TEXT,
    last_status INTEGER,
    UNIQUE (webhook_id, event_id)
  );
  CREATE INDEX delivery_due ON webhook_delivery(state, next_try_at);
  `;
