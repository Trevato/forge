// The kept front page asks one row whether the shelf's data changed, instead
// of reading every app and look (#6325). `front_epoch.n` is bumped by
// triggers on only the columns the shelf renders: never `repo.issue_seq` or
// `repo.last_fetch_at`, which move on every push, and on `look` only a
// production thumb. Additive.
export default `
  CREATE TABLE front_epoch (n INTEGER NOT NULL);
  INSERT INTO front_epoch (n) VALUES (0);

  CREATE TRIGGER front_epoch_app_insert AFTER INSERT ON app
  BEGIN UPDATE front_epoch SET n = n + 1; END;

  CREATE TRIGGER front_epoch_app_delete AFTER DELETE ON app
  BEGIN UPDATE front_epoch SET n = n + 1; END;

  CREATE TRIGGER front_epoch_app_update AFTER UPDATE OF repo_id, slug, access ON app
  BEGIN UPDATE front_epoch SET n = n + 1; END;

  CREATE TRIGGER front_epoch_repo_insert AFTER INSERT ON repo
  BEGIN UPDATE front_epoch SET n = n + 1; END;

  CREATE TRIGGER front_epoch_repo_delete AFTER DELETE ON repo
  BEGIN UPDATE front_epoch SET n = n + 1; END;

  CREATE TRIGGER front_epoch_repo_update AFTER UPDATE OF owner_id, name, visibility, description, archived_at, sealed_for ON repo
  BEGIN UPDATE front_epoch SET n = n + 1; END;

  CREATE TRIGGER front_epoch_front_pick_insert AFTER INSERT ON front_pick
  BEGIN UPDATE front_epoch SET n = n + 1; END;

  CREATE TRIGGER front_epoch_front_pick_delete AFTER DELETE ON front_pick
  BEGIN UPDATE front_epoch SET n = n + 1; END;

  CREATE TRIGGER front_epoch_front_pick_update AFTER UPDATE OF place, position ON front_pick
  BEGIN UPDATE front_epoch SET n = n + 1; END;

  CREATE TRIGGER front_epoch_front_setting_insert AFTER INSERT ON front_setting
  BEGIN UPDATE front_epoch SET n = n + 1; END;

  CREATE TRIGGER front_epoch_front_setting_delete AFTER DELETE ON front_setting
  BEGIN UPDATE front_epoch SET n = n + 1; END;

  CREATE TRIGGER front_epoch_front_setting_update AFTER UPDATE OF value ON front_setting
  BEGIN UPDATE front_epoch SET n = n + 1; END;

  CREATE TRIGGER front_epoch_user_insert AFTER INSERT ON user
  BEGIN UPDATE front_epoch SET n = n + 1; END;

  CREATE TRIGGER front_epoch_user_delete AFTER DELETE ON user
  BEGIN UPDATE front_epoch SET n = n + 1; END;

  CREATE TRIGGER front_epoch_user_update AFTER UPDATE OF username, suspended_at, removed_at ON user
  BEGIN UPDATE front_epoch SET n = n + 1; END;

  CREATE TRIGGER front_epoch_look_insert AFTER INSERT ON look
  WHEN NEW.env = 'production' AND NEW.kind = 'thumb'
  BEGIN UPDATE front_epoch SET n = n + 1; END;

  CREATE TRIGGER front_epoch_look_delete AFTER DELETE ON look
  WHEN OLD.env = 'production' AND OLD.kind = 'thumb'
  BEGIN UPDATE front_epoch SET n = n + 1; END;

  CREATE TRIGGER front_epoch_look_update AFTER UPDATE OF app_id, env, commit_oid, kind, path, error, taken_as ON look
  WHEN NEW.env = 'production' AND NEW.kind = 'thumb' OR OLD.env = 'production' AND OLD.kind = 'thumb'
  BEGIN UPDATE front_epoch SET n = n + 1; END;
  `;
