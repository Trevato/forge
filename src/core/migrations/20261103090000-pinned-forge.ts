// A pinned forge (#8697): a forge the owner put on their own cloud, which has
// no crew and no automatic release. Its version and config are changed only by
// a row in pinned_change (who, when, from, to); the trigger refuses any other
// UPDATE of them, and the CHECKs keep crew and auto_release at 0. Additive.
export default `
  CREATE TABLE pinned_forge (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL UNIQUE,
    target           TEXT NOT NULL,
    account          TEXT NOT NULL,
    app              TEXT NOT NULL,
    source           TEXT NOT NULL,
    version          TEXT NOT NULL,
    config           TEXT NOT NULL,
    crew             INTEGER NOT NULL DEFAULT 0 CHECK (crew = 0),
    auto_release     INTEGER NOT NULL DEFAULT 0 CHECK (auto_release = 0),
    change_id        INTEGER NOT NULL DEFAULT 0,
    remote           TEXT NOT NULL DEFAULT '',
    volume           TEXT NOT NULL DEFAULT '',
    state            TEXT NOT NULL DEFAULT 'new',
    created_at       TEXT NOT NULL
  );
  CREATE TABLE pinned_change (
    id           INTEGER PRIMARY KEY,
    pinned_id    TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('deploy','update','rollback')),
    from_version TEXT,
    to_version   TEXT NOT NULL,
    from_config  TEXT,
    to_config    TEXT NOT NULL,
    by           TEXT NOT NULL,
    at           TEXT NOT NULL
  );
  CREATE INDEX pinned_change_forge ON pinned_change (pinned_id, id);
  CREATE TRIGGER pinned_change_kept BEFORE UPDATE ON pinned_change
    BEGIN SELECT RAISE(ABORT, 'pinned: a recorded change is history'); END;
  CREATE TRIGGER pinned_change_kept_del BEFORE DELETE ON pinned_change
    BEGIN SELECT RAISE(ABORT, 'pinned: a recorded change is history'); END;
  CREATE TRIGGER pinned_only_by_update
    BEFORE UPDATE OF version, config ON pinned_forge
    WHEN NEW.version IS NOT OLD.version OR NEW.config IS NOT OLD.config
    BEGIN
      SELECT RAISE(ABORT, 'pinned: version and config change only through an explicit Update')
      WHERE NEW.change_id <= OLD.change_id OR NOT EXISTS (
        SELECT 1 FROM pinned_change c
        WHERE c.id = NEW.change_id AND c.pinned_id = OLD.id
          AND c.kind IN ('update','rollback')
          AND c.to_version = NEW.version AND c.to_config = NEW.config);
    END;
  `;
