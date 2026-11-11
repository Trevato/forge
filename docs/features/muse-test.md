# The Muse test: how an outsider reports a problem

An agent or person with no account, looking at a public app, needs no teaching.

1. **The door says it.** Every HTML page of a public app carries
   `Link: </__forge/report>; rel="help"` and a `rel="alternate"` to the forge's
   manifest for the repository (`/api/v1/here?path=/owner/app`). A private app
   carries neither and names nothing.
2. **Report a problem, no token.**
   - Page: follow `rel=help`; `/__forge/report?from=/page` sends you to
     `/owner/app/report`, told which page you came from.
   - HTTP: `POST /api/v1/repos/{owner}/{name}/reports` with
     `{"title", "body"?, "page"?, "agent"?}` answers `202`.
   - MCP: call `report` on `/mcp` with `{repo, title, body?, page?, agent?}`.
     `/.well-known/mcp.json` lists it in `tokenFreeTools`; every other tool needs a token.
3. **A person decides.** The report waits, marked `untrusted`, `from: "outside"`,
   with its page. A person who writes the repository accepts it as an issue
   (label `outside`, the stranger's words fenced, "Sent from: <page>") or dismisses it.
The door is open, so its limits hold: 3 reports a minute per source, 20 per
repository, 60 for the forge, 100 waiting per repository, and a request body
of at most 64 KiB (`413`). `test/muse-journey.test.ts` walks all of this
end to end and asserts the limits.
