// A repository can be FLOW ONLY (#6392): one switch its admin sets. Nothing
// obeys it yet; dispatch reads it in a later change.
export default `
  ALTER TABLE repo ADD COLUMN flow_only INTEGER NOT NULL DEFAULT 0;
  `;
