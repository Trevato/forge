// How a /talk turn that had a stored session went (#8795): `resumed` took it,
// `fallback` found it gone and started fresh, empty when there was none to
// resume. With the running version, never the text or the session.
export default `
  ALTER TABLE conversation_run ADD COLUMN resume_outcome TEXT NOT NULL DEFAULT '';
  ALTER TABLE conversation_run ADD COLUMN version TEXT NOT NULL DEFAULT '';
  `;
