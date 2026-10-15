// The chips a viewer switched off (#1811): a kind of post or one person,
// saved per viewer, beside their mutes.
export default `
  CREATE TABLE feed_chip (
    viewer_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    kind      TEXT NOT NULL CHECK (kind IN ('kind','person')),
    value     TEXT NOT NULL,
    PRIMARY KEY (viewer_id, kind, value)
  ) WITHOUT ROWID;
`;
