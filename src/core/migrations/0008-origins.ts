// 8 — origins. A connected account on another forge (GitHub, Forgejo,
// Gitea). Mirrored repos hang off an origin: their git objects are fetched
// from it on a schedule and their issues/pulls/comments are an index over
// the origin's — the origin is truth for them, as git is for native repos.
// Tokens are encrypted at rest with the data-dir key; nothing here is
// rebuildable from git, but everything here is rebuildable from the origin.
export default `
  CREATE TABLE origin (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('github','forgejo','gitea')),
    api_url      TEXT NOT NULL,
    web_url      TEXT NOT NULL,
    login        TEXT NOT NULL,
    token_enc    TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_sync_at TEXT,
    last_error   TEXT NOT NULL DEFAULT '',
    UNIQUE (user_id, api_url, login)
  );
  CREATE INDEX origin_user ON origin(user_id);

  -- Remote repos the origin reports, cached for the import picker.
  CREATE TABLE origin_repo (
    origin_id      TEXT NOT NULL REFERENCES origin(id) ON DELETE CASCADE,
    remote_id      TEXT NOT NULL,
    full_name      TEXT NOT NULL,
    description    TEXT NOT NULL DEFAULT '',
    private        INTEGER NOT NULL DEFAULT 0,
    fork           INTEGER NOT NULL DEFAULT 0,
    default_branch TEXT NOT NULL DEFAULT 'main',
    clone_url      TEXT NOT NULL,
    html_url       TEXT NOT NULL,
    pushed_at      TEXT,
    can_push       INTEGER NOT NULL DEFAULT 0,
    seen_at        TEXT NOT NULL,
    PRIMARY KEY (origin_id, remote_id)
  );

  -- Per-origin sync cursors (ETags, updated_at watermarks), keyed by name.
  CREATE TABLE origin_cursor (
    origin_id TEXT NOT NULL REFERENCES origin(id) ON DELETE CASCADE,
    key       TEXT NOT NULL,
    value     TEXT NOT NULL,
    PRIMARY KEY (origin_id, key)
  );

  ALTER TABLE repo ADD COLUMN origin_id TEXT REFERENCES origin(id) ON DELETE SET NULL;
  ALTER TABLE repo ADD COLUMN origin_full_name TEXT;
  ALTER TABLE repo ADD COLUMN origin_remote_id TEXT;
  ALTER TABLE repo ADD COLUMN origin_html_url TEXT;
  ALTER TABLE repo ADD COLUMN last_fetch_at TEXT;
  ALTER TABLE repo ADD COLUMN fetch_error TEXT NOT NULL DEFAULT '';
  CREATE INDEX repo_origin ON repo(origin_id);

  -- Imported rows remember where they came from. origin_author is the login
  -- on the origin; author_id stays the connecting user so joins keep working.
  ALTER TABLE issue ADD COLUMN origin_remote_id TEXT;
  ALTER TABLE issue ADD COLUMN origin_author TEXT;
  ALTER TABLE issue ADD COLUMN origin_html_url TEXT;
  ALTER TABLE issue ADD COLUMN synced_at TEXT;
  ALTER TABLE comment ADD COLUMN origin_remote_id TEXT;
  ALTER TABLE comment ADD COLUMN origin_author TEXT;
  ALTER TABLE label ADD COLUMN origin_remote_id TEXT;
  ALTER TABLE pull ADD COLUMN origin_head_repo TEXT;

  -- Pins: the repos a user wants on their machine. The local client clones
  -- and keeps these fresh; the server only remembers the choice.
  CREATE TABLE pin (
    user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    repo_id    TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (user_id, repo_id)
  );
  `;
