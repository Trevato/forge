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
export default `
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
  `;
