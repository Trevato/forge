# Does a forge I sent answer yet?

`GET /forges/<name>/ready` answers `{"ready":true|false,"step":"starting"|"answering"|"ready"}`
for a forge this one made, so the page a person waits on says what is happening:
`starting` while its process is not up yet, `answering` once it runs and its
public address is being asked, `ready` when that address answers.

- **How.** The parent probes the child's `/healthz` (800 ms at most) and says
  only yes or no: never the claim code, never the child's address.
- **Poll**: `curl https://<forge>/forges/<name>/ready`. The page a person waits on asks again a quarter of a second after each answer.
- **Errors.** A name that is not a child's name, or that this forge never made,
  is a `404 {"error":"not_found"}`. More than 300 asks a minute from one address
  is a `429` with `retry-after`. Every answer is `no-store`.
- **In the terminal:** open the palette (ctrl-k), "Does a forge answer?", pick
  a forge you sent; a toast says *answers* or *does not answer yet*. It uses the
  same `childReady` (`src/spawn/ready.ts`) as the route.
- Tests: `test/forge-ready.test.ts`.
