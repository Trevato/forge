// An app taken in as one of the forge's features (#40, "absorb"): which apps
// an admin absorbed, and the settings the forge keeps for them. Values are
// the canonical text `apps/feature.ts` checks; the declaration itself stays
// in the app's forge.json; `name` and `page` are copied from it for the nav,
// at absorb and at each start. Additive.
export default `
  CREATE TABLE app_feature (
    app_id      TEXT PRIMARY KEY,
    absorbed_by TEXT NOT NULL,
    absorbed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    -- what the nav says, as the declaration said it when last read
    name        TEXT NOT NULL,
    page        TEXT NOT NULL DEFAULT '/'
  );
  CREATE TABLE app_feature_setting (
    app_id  TEXT NOT NULL,
    key     TEXT NOT NULL,
    value   TEXT NOT NULL,
    set_by  TEXT NOT NULL,
    set_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (app_id, key)
  );
  `;
