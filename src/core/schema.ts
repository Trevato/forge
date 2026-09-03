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

  // 6 — SSH public keys. A user may register keys that authenticate them on
  // the SSH listener. The wire blob is stored as-is (base64); the OpenSSH
  // SHA256 fingerprint is the lookup key and is unique across the forge, so a
  // key identifies exactly one account.
  `
  CREATE TABLE user_key (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    algo         TEXT NOT NULL,
    blob         TEXT NOT NULL,
    fingerprint  TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_used_at TEXT
  );
  CREATE INDEX user_key_user ON user_key(user_id);
  `,

  // 7 — per-user interface preferences (the terminal's theme, today). Not
  // platform state: nothing outside the surface that wrote it consumes these,
  // so they carry no event and rebuilding one costs a keystroke.
  `
  CREATE TABLE user_setting (
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    key     TEXT NOT NULL,
    value   TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );
  `,

  // 8 — origins. A connected account on another forge (GitHub, Forgejo,
  // Gitea). Mirrored repos hang off an origin: their git objects are fetched
  // from it on a schedule and their issues/pulls/comments are an index over
  // the origin's — the origin is truth for them, as git is for native repos.
  // Tokens are encrypted at rest with the data-dir key; nothing here is
  // rebuildable from git, but everything here is rebuildable from the origin.
  `
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
  `,

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
  `
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
  `,

  // 10 — a short link for a connect in flight.
  //
  // The device grant asks a person to open a URL on a *different* device. In
  // a browser that is a link; in a terminal over SSH it is a string nobody
  // can click, copy reliably, or retype without error. So a flow gets a
  // 10-character code (50 bits of crypto randomness, unguessable within the
  // ten minutes it lives) that `/go/<code>` redirects to, which is short
  // enough to type by hand and to fit in a version 1–3 QR code.
  //
  // `target_enc` is where it redirects, sealed like every other secret this
  // table holds: for a code flow that URL carries the `state`, and the whole
  // point of storing the state as a digest is that a database read hands
  // nobody a usable one.
  `
  ALTER TABLE oauth_flow ADD COLUMN short_code TEXT;
  ALTER TABLE oauth_flow ADD COLUMN target_enc TEXT NOT NULL DEFAULT '';
  CREATE UNIQUE INDEX oauth_flow_short ON oauth_flow(short_code);
  `,

  // 11 — the indexes a busy forge needs, and one small table for retries.
  //
  // Every index here removes a scan that `EXPLAIN QUERY PLAN` showed on a
  // seeded forge (2 000 repos, 20 000 issues, 100 000 comments). They are
  // written to match the *whole* query — filter columns first, then the
  // ORDER BY — because an index that answers the filter but leaves SQLite
  // sorting is an index that stops helping exactly when the table grows.
  //
  // What is deliberately absent is as much of the point as what is here:
  // no index on `issue(updated_at)`, because nothing orders by it; none on
  // `event(actor_id)`, because nothing filters by it. An unused index is a
  // write tax with no reader.
  `
  -- Issue and pull lists: (repo, kind) then the paging key. Two indexes
  -- because "all states" and "one state" are genuinely different prefixes,
  -- and a list of pulls in a repo full of issues must not walk the issues.
  CREATE INDEX issue_repo_kind_number ON issue(repo_id, kind, number DESC);
  CREATE INDEX issue_repo_kind_state_number
    ON issue(repo_id, kind, state, number DESC);

  -- A thread's comments, and the count a list shows beside every row. The
  -- existing comment_issue index cannot serve the count without visiting
  -- every row to check its kind; this one answers it from the index alone.
  CREATE INDEX comment_issue_kind ON comment(issue_id, kind, id);

  -- Every event append asks this, so it must never be a table scan.
  CREATE INDEX webhook_repo_active ON webhook(repo_id, active);

  -- The delivery worker orders by id within one state; (state, next_try_at)
  -- answered the filter and then sorted, on the hottest loop in the forge.
  CREATE INDEX delivery_state_id ON webhook_delivery(state, id);

  -- Pins, newest first.
  CREATE INDEX pin_user_created ON pin(user_id, created_at DESC, repo_id DESC);

  -- Idempotency keys. A 24-hour cache, not truth: losing this table costs
  -- exactly what the forge costs without it (a retry may duplicate), which
  -- is why it can live here without breaking "git is truth".
  CREATE TABLE idempotency (
    token_id     TEXT NOT NULL,
    key          TEXT NOT NULL,
    fingerprint  TEXT NOT NULL,
    status       INTEGER NOT NULL,
    body         TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/json',
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    PRIMARY KEY (token_id, key)
  );
  CREATE INDEX idempotency_expiry ON idempotency(expires_at);
  `,
];
