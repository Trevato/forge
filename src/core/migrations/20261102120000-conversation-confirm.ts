// A held write is answered once (#7650): the person's yes stamps it, and a
// second yes finds it stamped. Its arguments are cleared on the yes, and by
// the sweep once it is ten minutes old unanswered, so a secret it carried
// is not kept past its time; the index keeps that sweep and the person's
// list of what still waits to the waiting rows alone.
export default `
  ALTER TABLE conversation_held ADD COLUMN answered_at TEXT;
  CREATE INDEX conversation_held_waiting ON conversation_held (user_id, created_at) WHERE answered_at IS NULL;
  `;
