// The weekly model review (#7815): each change of a crew member's model, with
// the numbers it was made on and, a week later, the numbers after it; and the
// time the review last ran, so it runs once a week.
export default `
  CREATE TABLE model_review (
    id           TEXT PRIMARY KEY,
    agent_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    from_model   TEXT NOT NULL,
    to_model     TEXT NOT NULL,
    state        TEXT NOT NULL CHECK (state IN ('asked','applied','declined','kept','undone')),
    why          TEXT NOT NULL,
    before_json  TEXT NOT NULL,
    after_json   TEXT,
    result       TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    decided_by   TEXT,
    applied_at   TEXT,
    settled_at   TEXT
  );
  CREATE INDEX model_review_agent ON model_review (agent_id, created_at);
  CREATE TABLE model_review_run (at TEXT NOT NULL);
  `;
