// An origin connected read-only: every write-through on its mirrors refuses
// (`origin_read_only`). Off for every row from before. Additive.
export default `
  ALTER TABLE origin ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
  `;
