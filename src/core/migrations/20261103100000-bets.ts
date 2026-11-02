// Bets (#8713): a name, an appetite (a share of the week), what done looks
// like in a few journeys, and scopes that are existing issues. One crew member
// leads. Additive: a repository with no bet picks as it always did.
export default `
  CREATE TABLE bet (
    id          TEXT PRIMARY KEY,
    repo_id     TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    journeys    TEXT NOT NULL DEFAULT '',
    appetite    INTEGER NOT NULL CHECK (appetite BETWEEN 1 AND 100),
    lead_id     TEXT REFERENCES user(id) ON DELETE SET NULL,
    state       TEXT NOT NULL DEFAULT 'proposed'
                CHECK (state IN ('proposed','backed','stopped','done','cut')),
    backed_by   TEXT NOT NULL DEFAULT '' CHECK (backed_by IN ('','owner','planner')),
    left_line   TEXT NOT NULL DEFAULT '',
    try_url     TEXT NOT NULL DEFAULT '',
    verdict     TEXT NOT NULL DEFAULT '' CHECK (verdict IN ('','done','not_yet')),
    verdict_why TEXT NOT NULL DEFAULT '',
    proposed_at TEXT NOT NULL,
    backed_at   TEXT,
    ended_at    TEXT
  );
  CREATE INDEX bet_repo_state ON bet (repo_id, state);
  CREATE TABLE bet_issue (
    bet_id   TEXT NOT NULL REFERENCES bet(id) ON DELETE CASCADE,
    issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    PRIMARY KEY (bet_id, issue_id)
  );
  CREATE INDEX bet_issue_issue ON bet_issue (issue_id);
  `;
