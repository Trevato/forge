// The base tip a pull's check merged its head with (#1810), so a green result
// says what it was green against. Empty for a check that merged nothing (a
// default-branch push) and for runs before this column.
export default `
  ALTER TABLE run ADD COLUMN base_oid TEXT NOT NULL DEFAULT '';
  `;
