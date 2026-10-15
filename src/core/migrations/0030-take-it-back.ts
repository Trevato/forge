// 30 — take it back: a pull that reverts another, named explicitly rather
// than sniffed from its title. `reverts_issue_id` points at the issue the
// shipped pull was (a pull is its own issue), so "was this already taken
// back" is one lookup rather than a guess from wording.
export default `
  ALTER TABLE pull ADD COLUMN reverts_issue_id TEXT REFERENCES issue(id) ON DELETE SET NULL;
  CREATE INDEX pull_reverts ON pull(reverts_issue_id) WHERE reverts_issue_id IS NOT NULL;
  `;
