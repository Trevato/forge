// 40 — a fleet operation's receipt (`core/fleet_ops.ts`): who acted, on
// which query, with what action, and per row the value before, the value
// asked for and what happened. Rows keep the target's words and no
// reference, so a receipt outlives a deleted repository. `undone_by`
// points at the operation that reversed this one.
export default `
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
  `;
