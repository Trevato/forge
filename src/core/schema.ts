/**
 * The whole schema, as linear migrations. Append-only: released migrations
 * are immutable history, exactly like commits. The database is an index over
 * truth that lives in git wherever possible — small on purpose.
 */

export const migrations: readonly string[] = [
  // 1 — foundation: users, sessions, tokens, repos, events, webhooks
  `
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
  `,

  // 2 — conversations: issues and (later) pulls share one table, one number
  // sequence per repo, one comment stream, one label system.
  `
  ALTER TABLE repo ADD COLUMN issue_seq INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE issue (
    id         TEXT PRIMARY KEY,
    repo_id    TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    number     INTEGER NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'issue' CHECK (kind IN ('issue','pull')),
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    author_id  TEXT NOT NULL REFERENCES user(id),
    state      TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    closed_at  TEXT,
    UNIQUE (repo_id, number)
  );
  CREATE INDEX issue_repo_state ON issue(repo_id, state, kind);

  CREATE TABLE comment (
    id         TEXT PRIMARY KEY,
    issue_id   TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    author_id  TEXT NOT NULL REFERENCES user(id),
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX comment_issue ON comment(issue_id, id);

  CREATE TABLE label (
    id      TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    color   TEXT NOT NULL DEFAULT '6b7280',
    UNIQUE (repo_id, name COLLATE NOCASE)
  );

  CREATE TABLE issue_label (
    issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES label(id) ON DELETE CASCADE,
    PRIMARY KEY (issue_id, label_id)
  );
  `,

  // 3 — pull requests: a 1:1 extension of an issue row, plus review-comment
  // anchoring that survives a force-push (path/line + the line's content hash).
  `
  CREATE TABLE pull (
    issue_id     TEXT PRIMARY KEY REFERENCES issue(id) ON DELETE CASCADE,
    base_branch  TEXT NOT NULL,
    head_branch  TEXT NOT NULL,
    base_oid     TEXT NOT NULL,
    head_oid     TEXT NOT NULL,
    merged_at    TEXT,
    merged_oid   TEXT,
    merged_by    TEXT REFERENCES user(id)
  );

  ALTER TABLE comment ADD COLUMN kind TEXT NOT NULL DEFAULT 'comment'
    CHECK (kind IN ('comment','review'));
  ALTER TABLE comment ADD COLUMN path TEXT;
  ALTER TABLE comment ADD COLUMN line INTEGER;
  ALTER TABLE comment ADD COLUMN side TEXT CHECK (side IN ('old','new'));
  ALTER TABLE comment ADD COLUMN commit_oid TEXT;
  ALTER TABLE comment ADD COLUMN line_hash TEXT;
  ALTER TABLE comment ADD COLUMN outdated INTEGER NOT NULL DEFAULT 0;
  `,

  // 4 — forks: a repo may descend from another. The git objects are shared via
  // alternates (instant, storage-bounded); the parent link records lineage and
  // gates the detach-before-delete path. A pull's head may live in another repo
  // (a fork), so it carries an explicit head_repo_id.
  `
  ALTER TABLE repo ADD COLUMN fork_parent_id TEXT REFERENCES repo(id);
  CREATE INDEX repo_fork_parent ON repo(fork_parent_id);

  ALTER TABLE pull ADD COLUMN head_repo_id TEXT REFERENCES repo(id);
  `,

  // 5 — organizations and teams. An org is a user row with kind 'org' (so it
  // owns repos through the same owner_id, no repo change). Teams belong to an
  // org, carry a permission level, and have members; a user's access to an
  // org's repos is the highest permission across the teams they're on.
  `
  ALTER TABLE user ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'
    CHECK (kind IN ('user','org'));

  CREATE TABLE team (
    id         TEXT PRIMARY KEY,
    org_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    permission TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read','write','admin')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (org_id, name COLLATE NOCASE)
  );

  CREATE TABLE team_member (
    team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    PRIMARY KEY (team_id, user_id)
  );
  CREATE INDEX team_member_user ON team_member(user_id);
  `,
];
