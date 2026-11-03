// A pull from another forge is a guest (#8964): its check and preview run
// without the repository's secrets until a person who can write approves it
// once. One row per approved pull, keyed by the pull's issue id. Additive.
export default `
  CREATE TABLE guest_approval (
    pull_id     TEXT PRIMARY KEY,
    approved_by TEXT NOT NULL,
    approved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `;
