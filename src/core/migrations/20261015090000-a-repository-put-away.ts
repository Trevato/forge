// Archive (#1838): when an admin put a repository away. Null is the
// ordinary state; nothing is deleted and clone and push go on working.
export default `
  ALTER TABLE repo ADD COLUMN archived_at TEXT;
  `;
