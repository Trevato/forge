// Outside agents' short-lived contribute tokens (#12012). `contribute_open` is a repository
// owner's yes to them; `contribute_token` names what an ordinary token is limited to (the
// repository, the agent name and origin as claimed, whether it has been renewed); `contribute_mint`
// counts mints per hashed address. Deleting a repository deletes its tokens. New tables only.
export default `
  CREATE TABLE contribute_open (
    repo_id TEXT PRIMARY KEY REFERENCES repo(id) ON DELETE CASCADE
  );
  CREATE TABLE contribute_token (
    token_id  TEXT PRIMARY KEY REFERENCES token(id) ON DELETE CASCADE,
    repo_id   TEXT NOT NULL,
    agent     TEXT NOT NULL,
    origin    TEXT NOT NULL,
    minted_at TEXT NOT NULL,
    renewed   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX contribute_token_repo ON contribute_token(repo_id);
  CREATE TABLE contribute_mint (
    source  TEXT NOT NULL,
    made_at INTEGER NOT NULL
  );
  CREATE INDEX contribute_mint_source ON contribute_mint(source, made_at);

  CREATE TRIGGER contribute_token_repo_gone BEFORE DELETE ON repo
  BEGIN
    DELETE FROM token WHERE id IN (SELECT token_id FROM contribute_token WHERE repo_id = OLD.id);
  END;
  `;
