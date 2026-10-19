// Every app measures its own visitors and page speed from its first deploy
// (#2714). The same report the forge's own pages send (`page_vital`), kept
// apart and filed under the app it came through, so the forge's numbers
// and an app's never mix. `visitor` is hashed under the day's rotating salt
// and the app's id; no address is kept. A row is dropped after 90 days (as `page_vital`'s are)
// and with its app. Production only: a preview's report is answered and dropped.
export default `
  CREATE TABLE app_vital (
    id      INTEGER PRIMARY KEY,
    app_id  TEXT NOT NULL,
    day     TEXT NOT NULL,
    at      INTEGER NOT NULL,
    visitor TEXT NOT NULL,
    load    REAL,
    inp     REAL
  );
  CREATE INDEX app_vital_app_day ON app_vital (app_id, day);
  CREATE INDEX app_vital_at ON app_vital (at);
  `;
