# A parent funds a child's crew (#10484)

A parent lends a child forge dollars of its own model credential. The child's
crew calls the model through the parent; the child never holds the credential.

## Use

- Set the cap (a site admin, `rw` token or session from the forge's own origin):
  `PUT /api/v1/forges/scottishbob/credit` with `{"usd":200}`. The first call mints the
  child's bearer and writes it into the child's `parent.json` (`credit.token`, mode 0600, like the
  proposal token); later calls only move the cap and keep what was spent.
- In the terminal (a site admin, same checks as the PUT, through `lendCredit`): the palette's
  **Lend a child credit** (`ctrl+k`) picks a forge you sent, then asks for the dollars (`200`, `12.50`).
  The forge list there shows "$3.20 of $200 lent" on the child's line; on the child, **Crew agents**
  carries the "funded by its parent: …" line.
- The parent's `/forges` row, the terminal's forge list and `GET /api/v1/forges` show
  `creditCapUsd` / `creditSpentUsd` ("$3.20 of $200 lent").
- The child's crew page says, in the readiness line, "…is ready to run the crew, funded by its parent: $196.80 of $200 left."; `GET /api/v1/credit`
  on the child answers the same (it asks the parent afresh; the page shows what the last
  heartbeat or ask kept).

## How it works

- `src/spawn/model_door.ts`: on the beat door (the loopback port a cell relays in,
  `FORGE_PARENT_LOCAL`) `POST /v1/messages` checks the bearer, refuses at the cap, forwards the call
  on the parent's own credential (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or
  `CLAUDE_CODE_OAUTH_TOKEN`, to `ANTHROPIC_BASE_URL` or api.anthropic.com), and counts the usage
  (JSON or streamed) at list price (`src/spawn/list_price.ts`).
- `src/spawn/credit.ts`: `<data>/credit/<child>.json`, the cap, the spend and the bearer's hash.
- `src/spawn/funding.ts`: the child's side. A run whose crew has no account granted gets
  `ANTHROPIC_BASE_URL=<parent door>` and the bearer (`credentialEnv`); an account the child granted
  itself still wins.
- At the cap: "scottishbob's $200 from its parent is spent; the parent's admin can raise it."
  (HTTP 402, in Anthropic's error shape, so the run says it).

## Assumptions, stated

- List price is Anthropic's published per-million-token rates by model family (Opus 15/75, Sonnet 3/15,
  Haiku 1/5; cache write 1.25x, cache read 0.1x); an unknown model is priced as Opus.
- A call under way when the cap is reached finishes and is counted. At most 4 calls per child run at
  once (a fifth is answered 429 at once), so the spend can pass the cap by no more than 4 calls cost.
- A request body is cut by the bytes that arrive, never by Content-Length; the bearer is checked
  before a byte is read (413 past 16 MB). A heartbeat must carry its signature and is read to 1 KB
  only. Bun holds one body limit per listener, so the listener's own limit is the model route's 16 MB.
- Bearers that do not check out are counted; past 30 a minute they are answered 429 (a good
  bearer is never refused for them).
- The hand-off comes first: the bearer is written into the child's `parent.json` before the parent
  saves anything, so a failed hand-off (502) leaves no credit and a retry mints again. A call for a
  child that holds no bearer also mints again, keeping its spend.
- The audit event `forge.credit_set` is an admins' event; readers are not told the dollars.
- No new egress: `children.modelEgress` is untouched; the door only reaches the one host the parent's
  own credential names.
- Not done: a spawn-time cap field (the PUT is the one door), and a funded hosted (in-process) child,
  which has no door to call.
