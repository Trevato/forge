// 74 — a look a person attached to a pull (#1066): who, and the one line
// saying what it shows. Both null for a look the forge took itself.
export default `
  ALTER TABLE look ADD COLUMN attached_by TEXT;
  ALTER TABLE look ADD COLUMN note TEXT;
  `;
