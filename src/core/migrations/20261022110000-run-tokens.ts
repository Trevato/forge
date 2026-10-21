// A crew run's token is an ordinary token plus one row naming the
// repository the run works on and the crew member's fork it pushes to;
// `http/run_gate.ts` keeps it there (#3963). Deleting either repository
// deletes the token, and with it the row.
export default `
  CREATE TABLE run_token (
    token_id  TEXT PRIMARY KEY REFERENCES token(id) ON DELETE CASCADE,
    repo_id   TEXT NOT NULL,
    fork_id   TEXT NOT NULL
  );
  CREATE INDEX run_token_repo ON run_token(repo_id);
  CREATE INDEX run_token_fork ON run_token(fork_id);

  CREATE TRIGGER run_token_repo_gone BEFORE DELETE ON repo
  BEGIN
    DELETE FROM token WHERE id IN (
      SELECT token_id FROM run_token WHERE repo_id = OLD.id OR fork_id = OLD.id
    );
  END;
  `;
