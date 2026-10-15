// 72 — when a mirror lost its origin (#1090). Disconnecting sets
// `repo.origin_id` NULL through the foreign key, from whichever path
// deleted the origin, so the database records the moment itself: the
// trigger fires for the key's own SET NULL. Re-attaching clears it
// (`linkRepoToOrigin`). A mirror detached before this ran says only that
// it was disconnected, never a date nobody knows.
export default `
  ALTER TABLE repo ADD COLUMN origin_detached_at TEXT;
  CREATE TRIGGER repo_origin_detached AFTER UPDATE OF origin_id ON repo
  WHEN OLD.origin_id IS NOT NULL AND NEW.origin_id IS NULL
  BEGIN
    UPDATE repo SET origin_detached_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = NEW.id;
  END;
  `;
