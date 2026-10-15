// 15 — an app's environment.
//
// The secrets an app reads at start-up (an admin password, a payment
// key) belong to the operator, not the repository, so they live beside
// the app row and never in the tree. Each value is sealed with the data
// directory's key (`kernel/secret.ts`), bound to `<app id>:<name>`, so a
// ciphertext moved between rows stops opening. Only the name is ever
// read back to a person: values are write-only by construction.
export default `
  CREATE TABLE app_env (
    app_id     TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    value_enc  TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (app_id, name)
  );
  `;
