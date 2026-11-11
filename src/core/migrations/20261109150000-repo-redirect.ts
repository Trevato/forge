// Where a moved repository went (#569): one row per old owner/name, naming
// the repository by id, so its old web and API paths answer 308 to wherever
// it lives now — even after a second move. Written by `transferRepo`
// (`core/transfer.ts`) in the same transaction as the repo row's new owner;
// a repository later made at the old path takes it back (the row is only
// read when no repository answers there). Cascades with the repository.
// `repo_transfer` is the audit trail: one row per move, never rewritten —
// who moved which repository from where to where, and when.
// Idempotent (#558): a second apply finds the table and changes nothing.
export default `
  CREATE TABLE IF NOT EXISTS repo_redirect (
    owner_name TEXT NOT NULL COLLATE NOCASE,
    name       TEXT NOT NULL COLLATE NOCASE,
    repo_id    TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    moved_by   TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (owner_name, name)
  );
  CREATE INDEX IF NOT EXISTS repo_redirect_repo ON repo_redirect(repo_id);
  CREATE TABLE IF NOT EXISTS repo_transfer (
    id         TEXT PRIMARY KEY,
    repo_id    TEXT NOT NULL,
    from_path  TEXT NOT NULL,
    to_path    TEXT NOT NULL,
    actor_id   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS repo_transfer_repo ON repo_transfer(repo_id, id);
  `;
