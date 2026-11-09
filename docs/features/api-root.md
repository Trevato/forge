# The API root

`GET /api/v1` (and `/api/v1/`) is the API's front door: an agent that starts there, with no account, learns what
this forge is and where everything else lives. HEAD answers too. It is public, read-only and small
(`src/http/api_root.ts`).

```
curl -i https://forge.example/api/v1
```

```json
{
  "name": "forge",
  "version": "0.7.480",
  "commit": "1bda42c9…",
  "openapi": "https://forge.example/api/v1/openapi.json",
  "mcp": "https://forge.example/mcp",
  "oauth": "https://forge.example/.well-known/oauth-protected-resource",
  "llms": "https://forge.example/llms.txt",
  "here": "https://forge.example/api/v1/here"
}
```

- Every URL is absolute and on the origin the request came to, so a preview points at itself.
- `version` and `commit` are what is running (`running()` in `src/kernel/version.ts`); `commit` is `null` when
  the build is unstamped.
- The reply carries the usual security headers and `cache-control: no-cache`.
- It is a read: `POST /api/v1` stays a 404 `no_route`.

`/llms.txt` mentions the root in its API line. The operation is described in the OpenAPI document and on `/api`
([the API reference](api-reference.md)).
