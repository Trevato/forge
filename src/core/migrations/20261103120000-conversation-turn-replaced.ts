// A /talk turn the person edited, regenerated or retried is kept and marked,
// not deleted (#8817): `replaced_at` is when it was set aside, and `failed`
// marks the line that says a run could not answer, which Retry answers.
export default `
  ALTER TABLE conversation_turn ADD COLUMN replaced_at TEXT;
  ALTER TABLE conversation_turn ADD COLUMN failed INTEGER NOT NULL DEFAULT 0;
  `;
