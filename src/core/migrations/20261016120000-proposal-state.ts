// a wave proposal is one inbox card (#1622): pending asks the owner, later
// hides it until they open it again, approved and redirected are decided.
export default `
  ALTER TABLE plan_proposal ADD COLUMN state TEXT NOT NULL DEFAULT 'pending';
  ALTER TABLE plan_proposal ADD COLUMN decided_at TEXT;
  `;
