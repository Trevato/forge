// Where a migrated repository came from (#3293): the source's address and,
// when its host said it is a fork, the chain it forks — links only, no
// credential and no connection. `shown` is the owner's "Show where this
// came from"; off hides the line and keeps the record.
//
// The backfill reads the one durable trace a migration left before this:
// its `push` event, `via: "migrate"`, whose `from` is the pasted address. A
// migration picked from a connected origin said only `owner/name` there,
// with no host to link, so it is left without a line.
export default `
  CREATE TABLE IF NOT EXISTS repo_provenance (
    repo_id     TEXT PRIMARY KEY REFERENCES repo(id) ON DELETE CASCADE,
    source_url  TEXT NOT NULL,
    parents     TEXT NOT NULL DEFAULT '[]',
    shown       INTEGER NOT NULL DEFAULT 1,
    migrated_at TEXT NOT NULL
  );
  INSERT OR IGNORE INTO repo_provenance (repo_id, source_url, migrated_at)
    SELECT e.repo_id,
           CASE WHEN lower(json_extract(e.payload, '$.from')) LIKE '%.git'
                THEN substr(json_extract(e.payload, '$.from'), 1,
                            length(json_extract(e.payload, '$.from')) - 4)
                ELSE json_extract(e.payload, '$.from') END,
           e.created_at
      FROM event e JOIN repo r ON r.id = e.repo_id
     WHERE e.kind = 'push'
       AND json_valid(e.payload)
       AND json_extract(e.payload, '$.via') = 'migrate'
       AND (json_extract(e.payload, '$.from') LIKE 'https://%'
            OR json_extract(e.payload, '$.from') LIKE 'http://%');
  `;
