// 46 — which address the forge's commits for a person carry (#623). The
// default is the no-reply one; the account email is an explicit opt-in.
export default `
  ALTER TABLE user ADD COLUMN commit_email TEXT NOT NULL DEFAULT 'noreply'
    CHECK (commit_email IN ('noreply','account'));
  `;
