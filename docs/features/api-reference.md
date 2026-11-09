# The API reference

`/api` renders the forge's OpenAPI document (`src/contract/openapi.ts`) as a page: operations grouped by area
(the first word after `/api/v1`), a search box (`?q=`, a plain GET form), and for each operation a fold with its
parameters, body fields and replies. It is server-rendered; the folds are `<details>`. Nothing is loaded from
elsewhere, and the one script (`API_TRY_JS` in `src/web/api_reference.ts`) is on this page only.

**Try it** sends the request as you (your session cookie) or as a token you paste, and shows the status, the time,
the `Server-Timing` header and the body. A GET with no path parameter also works with no script: the form is a plain
GET to the endpoint. A request that is not a GET asks to confirm first.

**An app's API tab.** An app whose production environment serves `/openapi.json` gets an **API** tab next to Runs,
at `/:owner/:name/api`, rendered by the same reading (`src/contract/reference.ts`). The forge reads the file over
loopback (bounded to 512 KB and 1.5 s, kept only when it is a JSON object with `paths`) and remembers it for a
minute (`src/apps/api_spec.ts`); the tab appears once the header has seen it. Try it is not offered on an app's
operations: they live on another origin.

**In the terminal:** `API` in the command palette lists the same operations; `/` narrows; Enter on a GET with no
path parameter runs it as the person at the terminal and shows the status, time, Server-Timing and body.

`/api` answers `no_route` in JSON to a caller whose `Accept` prefers JSON, as the rest of `/api` does.

A list the contract gives a `cursor` pages by it: `?page=` or `?offset=` on one is a 400 `invalid_query` ("This list pages by cursor: pass next_cursor as ?cursor="), answered by one guard in `src/http/cursor_lists.ts` before any handler runs, and named in the document as the route's 400.

The root, `GET /api/v1`, names the OpenAPI, MCP, OAuth and llms.txt URLs with no account: [the API root](api-root.md).
