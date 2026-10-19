// A restore drill keeps how long each restore phase took and the budget it had
// (#2622): JSON {phases, budgetMs}. An older drill has NULL and reads as none.
export default `
  ALTER TABLE drill ADD COLUMN phases TEXT;
  `;
