// A site admin's grant of one private destination ("100.89.95.68:8101") to a
// repository's cells (#3432). Additive; the repository's forge.json still has
// to declare the same destination for a grant to open anything.
export default `
  CREATE TABLE egress_grant (
    repo_id     TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    destination TEXT NOT NULL,
    granted_by  TEXT NOT NULL REFERENCES user(id),
    granted_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (repo_id, destination)
  );
  `;
