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
export default `
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
  `;
