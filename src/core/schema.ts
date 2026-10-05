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

  // 11 — counts on a list, and the index that keeps a search off a table
  // scan. A repo row is useless without "how much is open here", and asking
  // per row is the N+1 that turns fifty repos into a hundred queries; the
  // grouped helpers in core/repos.ts and core/issues.ts answer instead.
  //
  // For a *cached* origin repo we cannot compute the number — the origin
  // holds the conversations — so it is recorded as the origin states it,
  // honestly. GitHub's `open_issues_count` is issues AND pull requests in
  // one number and it will not separate them; Forgejo reports both. The
  // flag says which we were handed, so no surface has to guess whether a
  // number it is rendering means what it says.
  `
  ALTER TABLE origin_repo ADD COLUMN open_issues INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE origin_repo ADD COLUMN open_pulls INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE origin_repo ADD COLUMN counts_include_pulls INTEGER NOT NULL DEFAULT 0;

  -- Search orders issues by recency inside a bounded set of repos. Without
  -- this the ORDER BY is a scan of every issue in the forge.
  CREATE INDEX issue_repo_updated ON issue(repo_id, updated_at);
  `,

  // 12 — the indexes a busy forge needs, and one small table for retries.
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

  // 13 — review states, thread resolution, and the fork a mirror descends
  // from.
  //
  // A *review* is a verdict on a pull at one commit: approved, changes
  // requested, or a plain comment. It is a row of its own rather than a
  // flag on a comment, because the two are genuinely different things —
  // a line comment is anchored to a diff row and a verdict is anchored to
  // a commit — and because the merge gate has to be able to ask "is there
  // an approval *of this head*", which only a `commit_oid` can answer. A
  // verdict against an older head is stale by construction, so a force-push
  // dismisses it without anything having to remember to.
  //
  // Resolution hangs off the thread, not the comment: a thread is every
  // review comment sharing one anchor, and "resolved" is a property of the
  // conversation, not of any one line in it. `anchor` is the stable digest
  // of (path, side, line) that `anchorId` computes, so it is URL-safe and a
  // client can address a thread without reassembling a NUL-joined key.
  //
  // `repo.require_review` is the gate; `repo.origin_fork_of` and
  // `origin_repo.fork_of` are the two halves of "this is my fork of theirs"
  // — the local mirror remembers it, and the picker's cache remembers it for
  // a fork we have not mirrored yet, which is what lets the contribute flow
  // find an existing fork instead of making a second one.
  `
  CREATE TABLE review (
    id         TEXT PRIMARY KEY,
    issue_id   TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    author_id  TEXT NOT NULL REFERENCES user(id),
    state      TEXT NOT NULL CHECK (state IN ('approved','changes_requested','commented')),
    body       TEXT NOT NULL DEFAULT '',
    commit_oid TEXT NOT NULL DEFAULT '',
    origin_remote_id TEXT,
    origin_author    TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX review_issue ON review(issue_id, id);
  -- One row per imported review: the origin's id identifies it, and a
  -- partial index keeps native reviews (which have none) out of the way.
  CREATE UNIQUE INDEX review_origin
    ON review(issue_id, origin_remote_id) WHERE origin_remote_id IS NOT NULL;

  CREATE TABLE review_thread (
    issue_id    TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    anchor      TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by TEXT REFERENCES user(id),
    PRIMARY KEY (issue_id, anchor)
  );

  ALTER TABLE repo ADD COLUMN require_review INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE repo ADD COLUMN origin_fork_of TEXT;
  ALTER TABLE origin_repo ADD COLUMN fork_of TEXT;
  `,

  // 14 — apps, runs, and the crew (docs/APPS.md).
  //
  // An *app* is a repository that runs. The row holds only what git cannot:
  // the slug its hostnames are built from, who may reach it, and whether a
  // preview starts from a copy of production's data. How it runs is
  // `forge.json` in the tree; what is running is a process, and a process
  // is not state — every environment is rebuilt on boot from the default
  // branch and the open pulls.
  //
  // A *run* is the durable record of work done on a commit: a deploy (its
  // outcome is the check a pull shows) or an agent working an issue. Rows
  // are claimed `queued` → `running` with a compare-and-swap, so two
  // workers can never take one. A run belongs to a repository and, when it
  // is about a conversation, to that issue or pull; deleting either takes
  // its runs with it, because a run about nothing is nothing.
  //
  // An *agent* is a user (`is_agent`) with a model, a brief and a budget.
  // The flag lives beside `kind` rather than in it: `kind`'s CHECK was
  // written before agents existed and a column cannot be re-checked without
  // rebuilding `user` under every table that references it. `toUser` reads
  // the flag as `kind: "agent"`, so nothing above the row ever sees two
  // fields. Agents have no password (`password_hash` is empty, which no
  // verifier accepts) and act only through tokens minted for a run —
  // `token.expires_at` is what makes such a token die with the run.
  //
  // `issue.assignee_id` is how work reaches an agent: assigning is the
  // dispatch. It is a plain column with a single assignee on purpose — one
  // person or agent is on it, and that is legible.
  //
  // `repo.require_checks` is the second merge gate beside `require_review`:
  // the head's deploy run must be `ok`, read live inside `mergePull`.
  `
  ALTER TABLE user ADD COLUMN is_agent INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE token ADD COLUMN expires_at TEXT;
  ALTER TABLE issue ADD COLUMN assignee_id TEXT REFERENCES user(id) ON DELETE SET NULL;
  CREATE INDEX issue_assignee ON issue(assignee_id, state) WHERE assignee_id IS NOT NULL;
  ALTER TABLE repo ADD COLUMN require_checks INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE app (
    id           TEXT PRIMARY KEY,
    repo_id      TEXT NOT NULL UNIQUE REFERENCES repo(id) ON DELETE CASCADE,
    slug         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    access       TEXT NOT NULL CHECK (access IN ('public','private')),
    preview_data TEXT NOT NULL DEFAULT 'copy' CHECK (preview_data IN ('copy','empty')),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE run (
    id          TEXT PRIMARY KEY,
    repo_id     TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('deploy','agent')),
    issue_id    TEXT REFERENCES issue(id) ON DELETE CASCADE,
    env         TEXT NOT NULL DEFAULT '',
    commit_oid  TEXT NOT NULL DEFAULT '',
    branch      TEXT NOT NULL DEFAULT '',
    state       TEXT NOT NULL DEFAULT 'queued'
                CHECK (state IN ('queued','running','ok','failed','cancelled')),
    summary     TEXT NOT NULL DEFAULT '',
    actor_id    TEXT REFERENCES user(id) ON DELETE SET NULL,
    reason      TEXT NOT NULL DEFAULT '',
    session_id  TEXT NOT NULL DEFAULT '',
    cost_usd    REAL NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    started_at  TEXT,
    finished_at TEXT
  );
  CREATE INDEX run_repo ON run(repo_id, id DESC);
  CREATE INDEX run_issue ON run(issue_id, id DESC) WHERE issue_id IS NOT NULL;
  CREATE INDEX run_queue ON run(state, id) WHERE state IN ('queued','running');

  CREATE TABLE agent (
    user_id    TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    model      TEXT NOT NULL DEFAULT '',
    brief      TEXT NOT NULL DEFAULT '',
    budget_usd REAL NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES user(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- The crew of a repository: the agents that may read and write it. A
  -- personal repository is otherwise governed by ownership alone, and an
  -- agent is never an owner — so this is the one grant an agent can hold,
  -- and it stops at write. Admin over a repository stays with people.
  CREATE TABLE repo_crew (
    repo_id  TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    added_by TEXT REFERENCES user(id) ON DELETE SET NULL,
    added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (repo_id, user_id)
  );
  CREATE INDEX repo_crew_user ON repo_crew(user_id);
  `,

  // 15 — an app's environment.
  //
  // The secrets an app reads at start-up (an admin password, a payment
  // key) belong to the operator, not the repository, so they live beside
  // the app row and never in the tree. Each value is sealed with the data
  // directory's key (`kernel/secret.ts`), bound to `<app id>:<name>`, so a
  // ciphertext moved between rows stops opening. Only the name is ever
  // read back to a person: values are write-only by construction.
  `
  CREATE TABLE app_env (
    app_id     TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    value_enc  TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (app_id, name)
  );
  `,

  // 16 — a paused run.
  //
  // A run the provider turned away (a rate limit, a usage window) is
  // queued again for a moment after the limit lifts, and counts how many
  // times that has happened to one task, so a limit that never lifts is
  // not waited on forever.
  `
  ALTER TABLE run ADD COLUMN not_before TEXT;
  ALTER TABLE run ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
  `,

  // 17 — checks.
  //
  // A repository's own check (`check` in forge.json) runs as a run of a
  // third kind, on every push a pull or the default branch takes. SQLite
  // cannot widen a CHECK constraint in place, so the table is rebuilt
  // around the wider one; nothing references run by foreign key.
  `
  CREATE TABLE run_v2 (
    id          TEXT PRIMARY KEY,
    repo_id     TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('deploy','agent','check')),
    issue_id    TEXT REFERENCES issue(id) ON DELETE CASCADE,
    env         TEXT NOT NULL DEFAULT '',
    commit_oid  TEXT NOT NULL DEFAULT '',
    branch      TEXT NOT NULL DEFAULT '',
    state       TEXT NOT NULL DEFAULT 'queued'
                CHECK (state IN ('queued','running','ok','failed','cancelled')),
    summary     TEXT NOT NULL DEFAULT '',
    actor_id    TEXT REFERENCES user(id) ON DELETE SET NULL,
    reason      TEXT NOT NULL DEFAULT '',
    session_id  TEXT NOT NULL DEFAULT '',
    cost_usd    REAL NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    started_at  TEXT,
    finished_at TEXT,
    not_before  TEXT,
    attempt     INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO run_v2 (id, repo_id, kind, issue_id, env, commit_oid, branch, state, summary,
                      actor_id, reason, session_id, cost_usd, created_at, started_at,
                      finished_at, not_before, attempt)
    SELECT id, repo_id, kind, issue_id, env, commit_oid, branch, state, summary,
           actor_id, reason, session_id, cost_usd, created_at, started_at,
           finished_at, not_before, attempt FROM run;
  DROP TABLE run;
  ALTER TABLE run_v2 RENAME TO run;
  CREATE INDEX run_repo ON run(repo_id, id DESC);
  CREATE INDEX run_issue ON run(issue_id, id DESC) WHERE issue_id IS NOT NULL;
  CREATE INDEX run_queue ON run(state, id) WHERE state IN ('queued','running');
  `,

  // 18 — a run's lease.
  //
  // The process working a run renews this every so often; a running run
  // whose lease has gone stale was abandoned by a forge that died, or is
  // still being finished by a forge that is on its way out beside a new
  // one. Only the stale ones are failed on boot.
  `
  ALTER TABLE run ADD COLUMN heartbeat_at TEXT;
  `,

  // 19 — how many turns an agent's run took, beside what it cost.
  `
  ALTER TABLE run ADD COLUMN turns INTEGER NOT NULL DEFAULT 0;
  `,

  // 20 — issues that depend on issues: one row per edge, the plan itself.
  `
  CREATE TABLE issue_dependency (
    issue_id      TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    blocked_by_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    actor_id      TEXT REFERENCES user(id),
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (issue_id, blocked_by_id)
  );
  CREATE INDEX issue_dependency_blocker ON issue_dependency(blocked_by_id);
  `,

  // 21 — a repository can run on its own: how much, on what direction, with
  // what ceiling; and each crew member has a role in it.
  `
  ALTER TABLE repo ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'off';
  ALTER TABLE repo ADD COLUMN autonomy_direction TEXT NOT NULL DEFAULT '';
  ALTER TABLE repo ADD COLUMN autonomy_ceiling_usd REAL NOT NULL DEFAULT 20;
  ALTER TABLE repo ADD COLUMN autonomy_slots INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE repo ADD COLUMN autonomy_by TEXT REFERENCES user(id);
  ALTER TABLE repo ADD COLUMN direction_issue_id TEXT REFERENCES issue(id) ON DELETE SET NULL;
  ALTER TABLE repo_crew ADD COLUMN role TEXT NOT NULL DEFAULT 'builder';
  `,

  // 22 — the decision ledger: every fixed-choice decision the crew's
  // decider made, with what it saw, what it answered, and what came of it.
  `
  CREATE TABLE decision (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    repo_id    TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_id   TEXT REFERENCES issue(id) ON DELETE SET NULL,
    state      TEXT NOT NULL,
    answer     TEXT NOT NULL,
    p          REAL NOT NULL,
    by         TEXT NOT NULL,
    ms         INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    outcome    TEXT,
    outcome_at TEXT
  );
  CREATE INDEX decision_issue ON decision(issue_id, kind, created_at);
  CREATE INDEX decision_repo ON decision(repo_id, created_at);
  `,

  // 23 — the look: a picture of an environment at a commit, at each of two
  // widths, or the reason there is none. Rows go with the app.
  `
  CREATE TABLE look (
    id         TEXT PRIMARY KEY,
    app_id     TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
    env        TEXT NOT NULL,
    commit_oid TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('phone','desktop')),
    path       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    error      TEXT,
    UNIQUE (app_id, env, commit_oid, kind)
  );
  `,

  // 24 — a variable has a scope: every environment, production only, or
  // previews only, so a preview can carry a test key where production
  // carries the live one. The scope joins the key, which SQLite cannot add
  // to a primary key in place, so the table is rebuilt; every row that
  // existed meant "everywhere" and still does.
  `
  CREATE TABLE app_env_scoped (
    app_id     TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    scope      TEXT NOT NULL DEFAULT 'all'
               CHECK (scope IN ('all','production','preview')),
    value_enc  TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (app_id, name, scope)
  );
  INSERT INTO app_env_scoped (app_id, name, scope, value_enc, created_at, updated_at)
    SELECT app_id, name, 'all', value_enc, created_at, updated_at FROM app_env;
  DROP TABLE app_env;
  ALTER TABLE app_env_scoped RENAME TO app_env;
  `,

  // 25 — what a running app said when the forge knocked on its doors and
  // compared with its contract: one row per probe, kept, so the audit can
  // show the last word and what changed.
  `
  CREATE TABLE probe (
    id         TEXT PRIMARY KEY,
    app_id     TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
    commit_oid TEXT NOT NULL,
    verdict    TEXT NOT NULL CHECK (verdict IN ('ok','mismatch','unprobed','down')),
    said       TEXT NOT NULL,
    knocks     TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX probe_app ON probe (app_id, created_at);
  `,
  // 26 — subscriptions: the Claude accounts the crew works on, sealed, and the
  // grants that say which repository or organization (and which agent) each
  // one pays for. A run remembers the account it spent, for the ledger.
  `
  CREATE TABLE subscription (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind          TEXT NOT NULL CHECK (kind IN ('oauth','api_key')),
    token_enc     TEXT NOT NULL,
    resting_until TEXT,
    resting_said  TEXT NOT NULL DEFAULT '',
    last_used_at  TEXT,
    created_by    TEXT REFERENCES user(id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE subscription_grant (
    scope_id        TEXT NOT NULL,
    agent_id        TEXT NOT NULL DEFAULT '',
    subscription_id TEXT NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,
    PRIMARY KEY (scope_id, agent_id, subscription_id)
  );
  CREATE INDEX subscription_grant_scope ON subscription_grant (scope_id, agent_id);
  ALTER TABLE run ADD COLUMN subscription_id TEXT;
  `,

  // 27 — the moment a deploy started serving: set once, at the swap-in,
  // distinct from `finished_at` which waits on the tests beside it.
  `
  ALTER TABLE run ADD COLUMN serving_at TEXT;
  `,

  // 28 — a failed check's own detail: the pass/fail counts and the first
  // few failing names, recognised once from a `bun test` tail as the run
  // finishes (`checks/bun-test.ts`) and stored as JSON beside the run, so a
  // page that shows it never re-parses a log. Empty when the run passed or
  // its output was not recognised — the studio then says exactly what it
  // said before this column existed.
  `
  ALTER TABLE run ADD COLUMN check_detail TEXT NOT NULL DEFAULT '';
  `,

  // 29 — a third width: thumb, a picture taken small for a slot that only
  // ever showed one small, instead of a full phone or desktop picture
  // squeezed into it. SQLite's CHECK cannot be altered in place, so the
  // table is rebuilt; every row already there keeps its id and content.
  `
  CREATE TABLE look_new (
    id         TEXT PRIMARY KEY,
    app_id     TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
    env        TEXT NOT NULL,
    commit_oid TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('phone','desktop','thumb')),
    path       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    error      TEXT,
    UNIQUE (app_id, env, commit_oid, kind)
  );
  INSERT INTO look_new SELECT * FROM look;
  DROP TABLE look;
  ALTER TABLE look_new RENAME TO look;
  `,

  // 30 — take it back: a pull that reverts another, named explicitly rather
  // than sniffed from its title. `reverts_issue_id` points at the issue the
  // shipped pull was (a pull is its own issue), so "was this already taken
  // back" is one lookup rather than a guess from wording.
  `
  ALTER TABLE pull ADD COLUMN reverts_issue_id TEXT REFERENCES issue(id) ON DELETE SET NULL;
  CREATE INDEX pull_reverts ON pull(reverts_issue_id) WHERE reverts_issue_id IS NOT NULL;
  `,

  // 31 — a look knows which page it is of: `app.looks` in `forge.json` can
  // name more than the home page. `page` defaults to `/`, so every row
  // taken before this migration reads as exactly what it always was — a
  // picture of the home page. The unique constraint gains `page` so two
  // pages of one commit never collide; SQLite cannot alter a constraint in
  // place, so the table is rebuilt, as `look_new` was before it.
  `
  CREATE TABLE look_new (
    id         TEXT PRIMARY KEY,
    app_id     TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
    env        TEXT NOT NULL,
    commit_oid TEXT NOT NULL,
    page       TEXT NOT NULL DEFAULT '/',
    kind       TEXT NOT NULL CHECK (kind IN ('phone','desktop','thumb')),
    path       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    error      TEXT,
    UNIQUE (app_id, env, commit_oid, page, kind)
  );
  INSERT INTO look_new (id, app_id, env, commit_oid, kind, path, created_at, error)
    SELECT id, app_id, env, commit_oid, kind, path, created_at, error FROM look;
  DROP TABLE look;
  ALTER TABLE look_new RENAME TO look;
  `,

  // 32 — an app's own domains. One host names one app's production; the
  // token is published in DNS to prove the name is held, so it is not a
  // secret. `verified_at` is set by the first check that finds the proof
  // and never cleared by a later one; `said` is the last check's sentence.
  `
  CREATE TABLE app_domain (
    host        TEXT PRIMARY KEY,
    app_id      TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
    env         TEXT NOT NULL DEFAULT 'production',
    token       TEXT NOT NULL,
    created_by  TEXT REFERENCES user(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL,
    verified_at TEXT,
    checked_at  TEXT,
    said        TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX app_domain_app ON app_domain(app_id);
  `,

  // 33 — where a repository's next tell comes from when nobody is typing:
  // an Instagram account whose latest Reel's top comment becomes the crew's
  // next tell, once a day at `at_utc`. The token is sealed under the forge's
  // key, bound to the row; `last_media_id` is the Reel already told, so the
  // same one is never told twice; `last_said` is the last run's sentence.
  `
  CREATE TABLE prompt_source (
    id                 TEXT PRIMARY KEY,
    repo_id            TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    kind               TEXT NOT NULL,
    account            TEXT NOT NULL DEFAULT '',
    token_enc          TEXT NOT NULL,
    token_refreshed_at TEXT NOT NULL,
    at_utc             TEXT NOT NULL,
    created_by         TEXT REFERENCES user(id) ON DELETE SET NULL,
    created_at         TEXT NOT NULL,
    last_ran_at        TEXT,
    last_said          TEXT NOT NULL DEFAULT '',
    last_media_id      TEXT,
    last_issue_number  INTEGER
  );
  CREATE INDEX prompt_source_repo ON prompt_source(repo_id);
  `,

  // 34 — forge-level secrets: credentials the forge itself needs, sealed
  // under AAD `secret:<scope>:<name>` and never read back. `scope_id` is ''
  // for the forge, an org's or a repo's id otherwise.
  `
  CREATE TABLE secret (
    name         TEXT NOT NULL,
    scope        TEXT NOT NULL CHECK (scope IN ('forge','org','repo')),
    scope_id     TEXT NOT NULL DEFAULT '',
    value_enc    TEXT NOT NULL,
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_read_at TEXT,
    PRIMARY KEY (name, scope, scope_id)
  );
  `,

  // 35 — what a viewer did with a feed item: opened it, dwelled on it,
  // dismissed it, muted its app. One row per act; the feed's affinity is
  // these, counted with a decay. `item_id` is the feed's own id, and
  // `repo_id`/`actor_id` are what the act says it was about, so a row
  // outlives the event it named.
  `
  CREATE TABLE interaction (
    id         TEXT PRIMARY KEY,
    viewer_id  TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    item_id    TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN
      ('opened','dwelled','steered','told','swiped','shipped','shared','dismissed','muted')),
    repo_id    TEXT REFERENCES repo(id) ON DELETE CASCADE,
    actor_id   TEXT REFERENCES user(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX interaction_viewer ON interaction(viewer_id, id);
  `,

  // 36 — a share: one item, one sender, one recipient. A share is delivered
  // (it shows in the recipient's feed, boosted), queued (the recipient's
  // daily budget is spent; it waits and decays) or dropped (it decayed).
  // One row per item and recipient, ever: that is the dedupe. What the
  // item was is kept as words, so the row outlives the event it named.
  `
  CREATE TABLE share (
    id           TEXT PRIMARY KEY,
    item_id      TEXT NOT NULL,
    sender_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    recipient_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    repo_id      TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    link         TEXT NOT NULL,
    what         TEXT NOT NULL,
    state        TEXT NOT NULL CHECK (state IN ('delivered','queued','dropped')),
    created_at   TEXT NOT NULL,
    delivered_at TEXT,
    UNIQUE (item_id, recipient_id)
  );
  CREATE INDEX share_recipient ON share(recipient_id, state);
  CREATE INDEX share_sender ON share(sender_id, state);
  `,

  // 37 — the usage ledger (`core/usage.ts`): what each agent run spent,
  // attributed to subscription, app, agent and issue. `subscription_id` is
  // text, not a reference: a removed account's spend stays counted.
  //
  // Written to survive one ordering accident: for a while this migration
  // was numbered 36, and a preview's database migrated then has the ledger
  // at 36 and never ran `share`. So both are created only if missing —
  // a no-op everywhere 36 was `share`, the repair where it was not. The
  // `share` DDL is migration 36's, verbatim.
  `
  CREATE TABLE IF NOT EXISTS share (
    id           TEXT PRIMARY KEY,
    item_id      TEXT NOT NULL,
    sender_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    recipient_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    repo_id      TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    link         TEXT NOT NULL,
    what         TEXT NOT NULL,
    state        TEXT NOT NULL CHECK (state IN ('delivered','queued','dropped')),
    created_at   TEXT NOT NULL,
    delivered_at TEXT,
    UNIQUE (item_id, recipient_id)
  );
  CREATE INDEX IF NOT EXISTS share_recipient ON share(recipient_id, state);
  CREATE INDEX IF NOT EXISTS share_sender ON share(sender_id, state);

  CREATE TABLE IF NOT EXISTS usage (
    run_id          TEXT PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
    repo_id         TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_id        TEXT,
    agent_id        TEXT,
    subscription_id TEXT,
    tokens_in       INTEGER NOT NULL DEFAULT 0,
    tokens_out      INTEGER NOT NULL DEFAULT 0,
    cost_usd        REAL NOT NULL DEFAULT 0,
    wall_ms         INTEGER NOT NULL DEFAULT 0,
    outcome         TEXT NOT NULL CHECK (outcome IN ('ok','failed','paused')),
    at              TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
  CREATE INDEX IF NOT EXISTS usage_repo ON usage(repo_id, at);
  CREATE INDEX IF NOT EXISTS usage_subscription ON usage(subscription_id, at);
  `,

  // 38 — a subscription's standing (`core/standing.ts`): the last time the
  // provider said each window (5-hour, weekly) was full and when it resets,
  // and the share of every window the operator keeps for people.
  `
  CREATE TABLE subscription_limit (
    subscription_id TEXT NOT NULL REFERENCES subscription(id) ON DELETE CASCADE,
    span            TEXT NOT NULL CHECK (span IN ('5h','week')),
    resets_at       TEXT NOT NULL,
    observed_at     TEXT NOT NULL,
    said            TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (subscription_id, span)
  );
  ALTER TABLE subscription ADD COLUMN headroom_pct INTEGER NOT NULL DEFAULT 0
    CHECK (headroom_pct BETWEEN 0 AND 90);
  `,
  // 39 — whether the agent's shell was held to the sandbox policy, kept on
  // the run so an old one can be read honestly. NULL: the run predates this,
  // or is not an agent's. The note is why it was not, when it was not.
  `
  ALTER TABLE run ADD COLUMN sandbox_enforced INTEGER;
  ALTER TABLE run ADD COLUMN sandbox_note TEXT NOT NULL DEFAULT '';
  `,
  // 40 — a fleet operation's receipt (`core/fleet_ops.ts`): who acted, on
  // which query, with what action, and per row the value before, the value
  // asked for and what happened. Rows keep the target's words and no
  // reference, so a receipt outlives a deleted repository. `undone_by`
  // points at the operation that reversed this one.
  `
  CREATE TABLE fleet_operation (
    id         TEXT PRIMARY KEY,
    actor_id   TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    query      TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('repo','run','issue')),
    verb       TEXT NOT NULL,
    value      TEXT NOT NULL,
    reversible INTEGER NOT NULL,
    undo_of    TEXT,
    undone_by  TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX fleet_operation_actor ON fleet_operation(actor_id, id);
  CREATE TABLE fleet_operation_row (
    operation_id TEXT NOT NULL REFERENCES fleet_operation(id) ON DELETE CASCADE,
    position     INTEGER NOT NULL,
    target_id    TEXT NOT NULL,
    repo_id      TEXT NOT NULL,
    label        TEXT NOT NULL,
    before       TEXT NOT NULL,
    after        TEXT NOT NULL,
    outcome      TEXT NOT NULL
      CHECK (outcome IN ('ok','failed','refused','unchanged')),
    reason       TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (operation_id, position)
  );
  `,

  // 41 — the meter (`core/meter.ts`): what an app used, in the two
  // quantities a forge charges for. `meter` is one row per awake interval
  // of an environment, `ended` NULL while it runs and `beat_at` the last
  // instant it was seen running, so a crash is closed there at boot.
  // `storage` is one row per hourly sample of an app's bytes. `repo_id` is
  // text, not a reference: removing an app does not erase what it used.
  `
  CREATE TABLE meter (
    id         INTEGER PRIMARY KEY,
    repo_id    TEXT NOT NULL,
    env        TEXT NOT NULL,
    placement  TEXT NOT NULL CHECK (placement IN ('owned','cloud')),
    started_at TEXT NOT NULL,
    beat_at    TEXT NOT NULL,
    ended_at   TEXT
  );
  CREATE INDEX meter_repo ON meter(repo_id, started_at);
  CREATE UNIQUE INDEX meter_open ON meter(repo_id, env) WHERE ended_at IS NULL;

  CREATE TABLE storage (
    id         INTEGER PRIMARY KEY,
    repo_id    TEXT NOT NULL,
    data_bytes INTEGER NOT NULL CHECK (data_bytes >= 0),
    repo_bytes INTEGER NOT NULL CHECK (repo_bytes >= 0),
    at         TEXT NOT NULL
  );
  CREATE INDEX storage_repo ON storage(repo_id, at);
  CREATE INDEX storage_at ON storage(at);
  `,
  // 42 — every credential is a subscription (`core/subscriptions.ts`): the
  // forge's own token from its environment becomes the row `platform`, with
  // no sealed token, so its windows and spend read like any account's. The
  // ledger's runs on it, once `NULL`, are its. The ledger gains the run's
  // kind (build, plan, review, check) and a `running` line, written as a
  // session reports its spend and replaced when it ends. SQLite cannot widen
  // a CHECK in place, so the ledger is copied into a new table.
  `
  INSERT OR IGNORE INTO subscription (id, name, kind, token_enc)
    VALUES ('platform', 'platform (env)', 'oauth', '');
  CREATE TABLE usage_next (
    run_id          TEXT PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
    repo_id         TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_id        TEXT,
    agent_id        TEXT,
    subscription_id TEXT,
    kind            TEXT NOT NULL DEFAULT 'build'
                    CHECK (kind IN ('build','plan','review','check')),
    tokens_in       INTEGER NOT NULL DEFAULT 0,
    tokens_out      INTEGER NOT NULL DEFAULT 0,
    cost_usd        REAL NOT NULL DEFAULT 0,
    wall_ms         INTEGER NOT NULL DEFAULT 0,
    outcome         TEXT NOT NULL CHECK (outcome IN ('ok','failed','paused','running')),
    at              TEXT NOT NULL
  );
  INSERT INTO usage_next
    SELECT u.run_id, u.repo_id, u.issue_id, u.agent_id,
           COALESCE(u.subscription_id, 'platform'),
           CASE r.reason WHEN 'review' THEN 'review'
                         WHEN 'check_failed' THEN 'check' ELSE 'build' END,
           u.tokens_in, u.tokens_out, u.cost_usd, u.wall_ms, u.outcome, u.at
      FROM usage u LEFT JOIN run r ON r.id = u.run_id;
  DROP TABLE usage;
  ALTER TABLE usage_next RENAME TO usage;
  CREATE INDEX usage_at ON usage(at);
  CREATE INDEX usage_repo ON usage(repo_id, at);
  CREATE INDEX usage_subscription ON usage(subscription_id, at);
  UPDATE run SET subscription_id = 'platform'
   WHERE kind = 'agent' AND subscription_id IS NULL;
  `,
  // 43 — an interrupted run is not a park (`crew/interrupted.ts`). Park
  // notes written for runs the provider's limit, an unreachable API or a
  // restart ended were strikes against work nobody attempted; they are
  // reworded so they no longer start with the park note and no longer count.
  `
  UPDATE comment
     SET body = 'Interrupted, not parked: ' || substr(body, 21)
   WHERE body LIKE 'Parked by the crew: %'
     AND (body LIKE '%rate limit%' OR body LIKE '%rate-limit%'
       OR body LIKE '%rate_limit%' OR body LIKE '%session limit%'
       OR body LIKE '%usage limit%' OR body LIKE '%weekly limit%'
       OR body LIKE '%hit your % limit%' OR body LIKE '%overloaded%'
       OR body LIKE '%too many requests%' OR body LIKE '%(api_error)%'
       OR body LIKE '%may use is resting%' OR body LIKE '%resting —%'
       OR body LIKE '%ECONNREFUSED%' OR body LIKE '%ECONNRESET%'
       OR body LIKE '%ENOTFOUND%' OR body LIKE '%ETIMEDOUT%'
       OR body LIKE '%fetch failed%' OR body LIKE '%unable to connect%'
       OR body LIKE '%connection error%' OR body LIKE '%unreachable%'
       OR body LIKE '%without a pull: cancelled'
       OR body LIKE '%interrupted by a restart%');
  `,
  // 44 — why an issue closed (done, dropped, split), and whether a person
  // has confirmed an edge whose blocker closed for a reason other than done.
  `
  ALTER TABLE issue ADD COLUMN close_reason TEXT
    CHECK (close_reason IN ('done','dropped','split'));
  ALTER TABLE issue_dependency ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0;
  `,
  // 45 — OAuth clients registered dynamically (RFC 7591); step one of the
  // MCP's OAuth. IF NOT EXISTS keeps a replay harmless.
  `
  CREATE TABLE IF NOT EXISTS oauth_client (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  `,
  // 46 — which address the forge's commits for a person carry (#623). The
  // default is the no-reply one; the account email is an explicit opt-in.
  `
  ALTER TABLE user ADD COLUMN commit_email TEXT NOT NULL DEFAULT 'noreply'
    CHECK (commit_email IN ('noreply','account'));
  `,
  // 47 — a report from outside (`core/reports.ts`): words a stranger left on
  // a public repository, held apart from issues so nothing that reads issues
  // (the crew, the feed, search, the MCP) reads them until a person who
  // writes accepts one, which opens an ordinary issue in that person's name.
  `
  CREATE TABLE IF NOT EXISTS report (
    id           TEXT PRIMARY KEY,
    repo_id      TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    body         TEXT NOT NULL,
    page         TEXT,
    state        TEXT NOT NULL DEFAULT 'pending'
                 CHECK (state IN ('pending','accepted','dismissed')),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    decided_by   TEXT REFERENCES user(id) ON DELETE SET NULL,
    decided_at   TEXT,
    issue_number INTEGER
  );
  CREATE INDEX IF NOT EXISTS report_waiting ON report(repo_id, state, id);
  `,
  // 48 — "outsiders may trigger the crew" (#619): off, so only people who
  // can write to a repository start or steer its crew.
  `
  ALTER TABLE repo ADD COLUMN crew_outsiders INTEGER NOT NULL DEFAULT 0;
  `,
];
