// The merge queue survives a roll (#6611): each gate's candidate as it was
// built — its steps' commits and trees, the base, the tip the check lane
// runs as `run_id`, since when — and its verdict once it has one, so the
// forge that carries on resumes that very candidate instead of planning the
// line again. `queue_red` keeps the queue's red marks by pull, head and base
// (`checks/queue_store.ts`). Two new tables.
export default `
  CREATE TABLE IF NOT EXISTS queue_gate (
    id            TEXT PRIMARY KEY,
    repo_id       TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    run_id        TEXT NOT NULL,
    base_oid      TEXT NOT NULL,
    base_tree_oid TEXT NOT NULL,
    tip_oid       TEXT NOT NULL,
    tree_oid      TEXT NOT NULL,
    steps         TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    verdict       TEXT
  );
  CREATE INDEX IF NOT EXISTS queue_gate_repo ON queue_gate (repo_id, started_at);
  CREATE TABLE IF NOT EXISTS queue_red (
    repo_id  TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    pull_id  TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    head_oid TEXT NOT NULL,
    base_oid TEXT NOT NULL,
    together TEXT NOT NULL DEFAULT '[]',
    at       TEXT NOT NULL,
    PRIMARY KEY (pull_id, head_oid, base_oid)
  );
  `;
