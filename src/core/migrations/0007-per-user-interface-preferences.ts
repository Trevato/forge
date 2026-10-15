// 7 — per-user interface preferences (the terminal's theme, today). Not
// platform state: nothing outside the surface that wrote it consumes these,
// so they carry no event and rebuilding one costs a keystroke.
export default `
  CREATE TABLE user_setting (
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    key     TEXT NOT NULL,
    value   TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );
  `;
