// 32 — an app's own domains. One host names one app's production; the
// token is published in DNS to prove the name is held, so it is not a
// secret. `verified_at` is set by the first check that finds the proof
// and never cleared by a later one; `said` is the last check's sentence.
export default `
  CREATE TABLE app_domain (
    host        TEXT PRIMARY KEY,
    app_id      TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
    env         TEXT NOT NULL DEFAULT 'production',
    token       TEXT NOT NULL,
    created_by  TEXT REFERENCES user(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL,
    verified_at TEXT,
    checked_at  TEXT,
    said        TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX app_domain_app ON app_domain(app_id);
  `;
