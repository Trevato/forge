// A writer's shell into a machine (#9471, `machines/shell.ts`): one row per
// session — the repository, the machine's name, whose it is, when it started
// and when and why it ended. The last sessions are read newest first per
// repository, so the index leads with the repository and the start. New
// table only. Additive.
export default `
  CREATE TABLE machine_sessions (
    id          TEXT PRIMARY KEY,
    repo_id     TEXT NOT NULL,
    machine     TEXT NOT NULL,
    owner_id    TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    ended_at    TEXT,
    end_reason  TEXT CHECK (end_reason IN ('exit', 'idle', 'stopped', 'revoked', 'failed'))
  );
  CREATE INDEX machine_sessions_repo_started ON machine_sessions (repo_id, started_at DESC);
  `;
