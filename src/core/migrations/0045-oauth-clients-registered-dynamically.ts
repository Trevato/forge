// 45 — OAuth clients registered dynamically (RFC 7591); step one of the
// MCP's OAuth. IF NOT EXISTS keeps a replay harmless.
export default `
  CREATE TABLE IF NOT EXISTS oauth_client (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );
  `;
