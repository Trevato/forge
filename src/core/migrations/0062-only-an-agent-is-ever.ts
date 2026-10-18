// 62 — only an agent is ever on a crew, said by the database itself: every
// route that puts someone on one (settings, the API, a migration, crew
// from forks, spawn's copy) meets the same refusal, and the SQL write
// check (`REPO_WRITABLE`'s crew clause) and `onCrew` can never drift.
// A person already there is reported at boot (`peopleOnCrews`), never
// removed by a migration.
// The RAISE messages below are shown to any caller, anonymous ones included
// (#723); they are written for anyone, and are known by name in
// src/http/refusal.ts because the numbered migrations' text is frozen.
export default `
  CREATE TRIGGER repo_crew_agents_only BEFORE INSERT ON repo_crew
  WHEN NOT EXISTS (SELECT 1 FROM user WHERE id = NEW.user_id AND is_agent = 1)
  BEGIN
    SELECT RAISE(ABORT, 'only an agent can be on a crew');
  END;
  CREATE TRIGGER repo_crew_agents_only_update BEFORE UPDATE OF user_id ON repo_crew
  WHEN NOT EXISTS (SELECT 1 FROM user WHERE id = NEW.user_id AND is_agent = 1)
  BEGIN
    SELECT RAISE(ABORT, 'only an agent can be on a crew');
  END;
  `;
