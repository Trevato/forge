// When a person last loaded home (#5804): the "Since you were here" digest
// starts there. One row per user, written at most once a minute.
export default `
  CREATE TABLE home_visit (
    user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    at      INTEGER NOT NULL
  ) WITHOUT ROWID;
`;
