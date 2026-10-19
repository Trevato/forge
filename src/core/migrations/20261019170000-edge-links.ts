// A person links the platform edge's login to their account (#2596). One
// edge login belongs to at most one account (the primary key); an account
// has at most one link (the unique index). Case does not tell logins apart.
export default `
  CREATE TABLE edge_link (
    login   TEXT PRIMARY KEY COLLATE NOCASE,
    user_id TEXT NOT NULL UNIQUE REFERENCES user(id) ON DELETE CASCADE,
    at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `;
