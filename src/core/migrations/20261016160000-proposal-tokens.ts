// A proposal token is an ordinary token plus one row naming the parent
// repository, the child it speaks for and where that child lives. Deleting
// the parent, or the child repository when one is named, deletes the tokens
// (and with them their rows). A pull opened with one keeps the child and
// origin beside it. Tokens already without a repository are not touched.
export default `
  CREATE TABLE proposal_token (
    token_id       TEXT PRIMARY KEY REFERENCES token(id) ON DELETE CASCADE,
    repo_id        TEXT NOT NULL,
    child          TEXT NOT NULL,
    child_repo_id  TEXT,
    origin         TEXT NOT NULL
  );
  CREATE INDEX proposal_token_repo ON proposal_token(repo_id);
  CREATE INDEX proposal_token_child_repo ON proposal_token(child_repo_id);

  CREATE TABLE pull_proposal (
    issue_id  TEXT PRIMARY KEY REFERENCES issue(id) ON DELETE CASCADE,
    child     TEXT NOT NULL,
    origin    TEXT NOT NULL
  );

  CREATE TRIGGER proposal_token_repo_gone BEFORE DELETE ON repo
  BEGIN
    DELETE FROM token WHERE id IN (
      SELECT token_id FROM proposal_token
       WHERE repo_id = OLD.id OR child_repo_id = OLD.id
    );
  END;
  `;
