// The week's budget as valves (#8698). `flow_valve` is one stored value per
// repository: the share of the week's agent starts it may hold, 0 (shut) to
// 100 (open); no row is open. Only a person writes it. `flow_valve_turn`
// keeps every turn, so the page can say what a turn did. `flow_look` counts
// where a person looks, per day, to suggest a valve and never to set one.
export default `
  CREATE TABLE IF NOT EXISTS flow_valve (
    repo_id TEXT PRIMARY KEY REFERENCES repo(id) ON DELETE CASCADE,
    level INTEGER NOT NULL CHECK (level BETWEEN 0 AND 100),
    set_by TEXT REFERENCES user(id) ON DELETE SET NULL,
    set_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS flow_valve_turn (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    from_level INTEGER NOT NULL,
    to_level INTEGER NOT NULL,
    by_id TEXT REFERENCES user(id) ON DELETE SET NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS flow_valve_turn_at ON flow_valve_turn (at);
  CREATE TABLE IF NOT EXISTS flow_look (
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    repo_id TEXT NOT NULL REFERENCES repo(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, repo_id, day)
  );
  `;
