// The boxes a crew reviewer read at an approved head (#8682), held until the
// pull lands and applied only if the head is still the one read. One row per
// pull: a later approval replaces it. Additive.
export default `
  CREATE TABLE pull_pass (
    pull_id     TEXT PRIMARY KEY,
    reviewer_id TEXT NOT NULL,
    head_oid    TEXT NOT NULL,
    pass        TEXT NOT NULL
  );
  `;
