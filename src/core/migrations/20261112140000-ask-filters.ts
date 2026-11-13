// The filters an owner sets on their asks (#11820): an app hidden (for a day or
// until shown again) or a kind of decision hidden, saved per person. A hidden
// ask is never touched; the filter only decides whether it shows.
export default `
  CREATE TABLE ask_filter (
    viewer_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    kind      TEXT NOT NULL CHECK (kind IN ('app','kind')),
    value     TEXT NOT NULL,
    until     TEXT,
    PRIMARY KEY (viewer_id, kind, value)
  ) WITHOUT ROWID;
`;
