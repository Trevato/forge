// An app granted a device may print on it through the forge (#10568).
// `device_grant` is the owner's yes, one row per (device, app); `app_token`
// says which app a running process's token belongs to, so the forge knows who
// is asking from the credential and not from a name anyone could choose.
// Both rows go with the device, the app or the token. Additive.
export default `
  CREATE TABLE device_grant (
    device_id  INTEGER NOT NULL REFERENCES device(id) ON DELETE CASCADE,
    app_id     TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE,
    granted_by TEXT REFERENCES user(id) ON DELETE SET NULL,
    granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (device_id, app_id)
  );
  CREATE TABLE app_token (
    token_id TEXT PRIMARY KEY REFERENCES token(id) ON DELETE CASCADE,
    app_id   TEXT NOT NULL REFERENCES app(id) ON DELETE CASCADE
  );
  `;
