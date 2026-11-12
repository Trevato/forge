// A variant: a branch of an app kept running as its own environment
// (`<slug>--v-<label>`), with values it carries in `variant.json` on the
// branch. One row per (app, label); a branch is one variant at most.
// Additive; the row is the index, the branch and its file are the truth.
export default `
  CREATE TABLE app_variant (
    app_id     TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
    label      TEXT NOT NULL,
    branch     TEXT NOT NULL,
    created_by TEXT REFERENCES user(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (app_id, label),
    UNIQUE (app_id, branch)
  );
  `;
