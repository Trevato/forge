// One row per merge-queue gate (#6426, checks/gate_record.ts): when it took a
// check slot and when it let go of it, so the flow's gate minutes are one
// read (`flow/gate_minutes.ts`). A gate writes no `run`; this is its whole
// trace. Rows past a week are pruned as new ones are written. Additive.
export default `
  CREATE TABLE check_gate (
    id          TEXT PRIMARY KEY,
    repo_id     TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    issue_id    TEXT REFERENCES issue(id) ON DELETE SET NULL,
    commit_oid  TEXT NOT NULL DEFAULT '',
    started_at  TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX check_gate_started ON check_gate(started_at);
  `;
