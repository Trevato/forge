// The migrate picker shows each repository's size before it is cloned
// (#3264). Both forges report `size` in KiB on a listing; additive, and 0
// reads as "the origin did not say".
export default `
  ALTER TABLE origin_repo ADD COLUMN size_kb INTEGER NOT NULL DEFAULT 0;
  `;
