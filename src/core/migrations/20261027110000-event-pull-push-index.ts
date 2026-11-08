// A pull's newest push, found by its number inside one repository (#6896), so
// the idle-pulls read never scans every event the forge has. Additive.
export default `
  CREATE INDEX IF NOT EXISTS event_repo_kind_number_at
    ON event(repo_id, kind, json_extract(payload, '$.number'), created_at);
  `;
