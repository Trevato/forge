// 78 — variants (#1643): a pull and a run may belong to a variant group,
// a name shared by the pulls that try the same thing. Null for an ordinary
// one; nothing reads it but the pull JSON yet.
export default `
  ALTER TABLE pull ADD COLUMN variant_group TEXT;
  ALTER TABLE run ADD COLUMN variant_group TEXT;
  CREATE INDEX pull_variant_group ON pull(variant_group) WHERE variant_group IS NOT NULL;
  `;
