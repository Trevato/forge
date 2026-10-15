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
export default `
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
  `;
