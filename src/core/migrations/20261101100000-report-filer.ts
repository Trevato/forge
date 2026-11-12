// Who filed a report from outside (#7658): `filer_id` is the account a token
// or session proved, `claimed` a name given without one — a claim, shown as
// one. Neither is set for an anonymous report.
export default `
  ALTER TABLE report ADD COLUMN filer_id TEXT REFERENCES user(id) ON DELETE SET NULL;
  ALTER TABLE report ADD COLUMN claimed TEXT;
  `;
