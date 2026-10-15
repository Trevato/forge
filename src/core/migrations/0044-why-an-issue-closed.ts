// 44 — why an issue closed (done, dropped, split), and whether a person
// has confirmed an edge whose blocker closed for a reason other than done.
export default `
  ALTER TABLE issue ADD COLUMN close_reason TEXT
    CHECK (close_reason IN ('done','dropped','split'));
  ALTER TABLE issue_dependency ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0;
  `;
