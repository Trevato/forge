// The platform's forwardAuth edge goes (#11802). Every account the edge made
// is mapped once to the login it forwarded (its username then), in
// `edge_link`, so the mapping is a row and not an inference from an event.
// A login already linked to another account, or an account already linked,
// is left as it is (INSERT OR IGNORE; the unique user_id is checked first).
// `edge_handover` holds one way-back link per account, minted by an admin
// for a mapped account with no password, passkey or parent link: its secret
// stored only as a hash, single-use, expiring. Additive.
export default `
  INSERT OR IGNORE INTO edge_link (login, user_id)
    SELECT u.username, u.id FROM user u
     WHERE u.kind = 'user' AND u.is_agent = 0
       AND NOT EXISTS (SELECT 1 FROM edge_link l WHERE l.user_id = u.id)
       AND EXISTS (SELECT 1 FROM event e WHERE e.kind = 'user.created'
                    AND e.actor_id = u.id
                    AND CASE WHEN json_valid(e.payload)
                             THEN json_extract(e.payload, '$.via') END = 'edge');
  CREATE TABLE edge_handover (
    user_id    TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    by_id      TEXT REFERENCES user(id) ON DELETE SET NULL,
    at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `;
