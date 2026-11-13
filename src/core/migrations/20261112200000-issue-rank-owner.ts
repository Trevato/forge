// Who ranked (#11753): 1 when a person placed the row, 0 when the planner or
// a keeper did. An owner's row stays where it is until a person moves it.
// Additive; existing rows were all placed by a person's move.
export default `
  ALTER TABLE issue_rank ADD COLUMN by_owner INTEGER NOT NULL DEFAULT 1;
  `;
