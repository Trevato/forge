// 70 — a sealed repository is never public, said by the database (#865's
// review): the rule lived in `updateRepoSettings`; these triggers hold
// it for every writer of `repo.visibility`, now and later.
// The RAISE messages below are shown to any caller, anonymous ones included
// (#723); they are written for anyone, and are known by name in
// src/http/refusal.ts because the numbered migrations' text is frozen.
export default `
  CREATE TRIGGER repo_sealed_never_public BEFORE UPDATE OF visibility, sealed_for ON repo
  WHEN NEW.sealed_for IS NOT NULL AND NEW.visibility = 'public'
  BEGIN
    SELECT RAISE(ABORT, 'a sealed repository is never public');
  END;
  CREATE TRIGGER repo_sealed_never_public_insert BEFORE INSERT ON repo
  WHEN NEW.sealed_for IS NOT NULL AND NEW.visibility = 'public'
  BEGIN
    SELECT RAISE(ABORT, 'a sealed repository is never public');
  END;
  `;
