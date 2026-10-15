// 48 — an account the owner suspended or removed (#660). Columns are added,
// never a table rebuilt: a rebuild would drop any trigger on \`user\`.
export default `
  ALTER TABLE user ADD COLUMN suspended_at TEXT;
  ALTER TABLE user ADD COLUMN removed_at TEXT;
  `;
