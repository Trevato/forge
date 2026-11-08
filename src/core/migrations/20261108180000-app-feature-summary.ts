// The menu entry of an absorbed feature carries its declared summary as its
// title (#9681). Like `name` and `page`, it is copied from the declaration
// when an admin absorbs or accepts it, so a page never reads git for it.
// Additive; null for rows absorbed before, and for a declaration with none.
export default `
  ALTER TABLE app_feature ADD COLUMN summary TEXT;
  `;
