# Does a forge I sent answer yet?

`GET /forges/<name>/ready` answers `{"ready":true}` or `{"ready":false}` for a
forge this one made, so a page can wait before sending someone to a child that
is still booting.

- **How.** The parent probes the child's `/healthz` (800 ms at most) and says
  only yes or no: never the claim code, never the child's address.
- **Poll** every two seconds: `curl https://<forge>/forges/<name>/ready`.
- **Errors.** A name that is not a child's name, or that this forge never made,
  is a `404 {"error":"not_found"}`. More than 60 asks a minute from one address
  is a `429` with `retry-after`. Every answer is `no-store`.
- **In the terminal:** open the palette (ctrl-k), "Does a forge answer?", pick
  a forge you sent; a toast says *answers* or *does not answer yet*. It uses the
  same `childReady` (`src/spawn/ready.ts`) as the route.
- Tests: `test/forge-ready.test.ts`.
