// `first_ask_refusals` (#11525): one row for each refused first ask: who asked (null when nobody
// was signed in), the first 200 characters, and the refusal's words. Kept 30 days. New table only. Additive.
export default `
  CREATE TABLE first_ask_refusals (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    at       INTEGER NOT NULL,
    actor_id TEXT,
    ask      TEXT    NOT NULL,
    words    TEXT    NOT NULL
  );
  CREATE INDEX first_ask_refusals_at ON first_ask_refusals (at);
  `;
