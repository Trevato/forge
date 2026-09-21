# MCP — the forge as a connector

`POST /mcp` is the forge as a Model Context Protocol server: the studio's
verbs as tools, so an assistant a person already talks to can run their forge
from wherever they are. It is the same forge through another door — every
tool calls the action the page calls, with the same checks — and it is built
for a tunnel and a forge that sleeps.

## Shape

- **One short call, one JSON answer.** The Streamable HTTP transport, used
  the plain way: a JSON-RPC request in, `application/json` out. No
  server-sent stream is ever opened (`GET /mcp` is 405), so there is nothing
  for a proxy to cut at a hundred seconds, and nothing to reconnect.
- **The first call wakes it.** A forge scaled to zero is woken by the request
  like any page; a client's retry on a slow first answer is safe, because
  every write is an ordinary forge action and the reads change nothing.
- **A token, never a cookie.** `Authorization: Bearer <forge token>`. A
  browser session is refused even when signed in: a cookie is what a
  cross-site page could ride, and this door has no page. An `ro` token reads;
  an `rw` token acts; the tools say which they are (`readOnlyHint`).
- **What you may not do on a page you may not do here.** A private app is
  "no such app" to someone who cannot read it; stopping a run is a writer's.

## Tools

| tool           | does                                                                                   | writes |
| -------------- | -------------------------------------------------------------------------------------- | ------ |
| `apps`         | the apps you can see: live or not, where served, how each runs itself, what asks you   |        |
| `asks`         | what waits for you across every app: green changes to look at, stopped ones, ceilings  |        |
| `decide`       | answer an ask: `ship` a green change, `close` one; a conflict goes to the builder      | yes    |
| `tell`         | a sentence becomes an issue, a builder is picked, a run starts on the crew's next tick | yes    |
| `say`          | speak on an issue or a pull; a working builder hears it as its next step               | yes    |
| `now`          | what the crew is doing right now: who, on what, since when, at what cost               |        |
| `stop`         | stop one run by its id from `now`                                                      | yes    |
| `following`    | where a fork stands against what it follows, and what the crew is doing about it       |        |
| `take_updates` | a fork takes its parent's updates when git can do it alone; a conflict is refused      | yes    |
| `converge`     | the fork's crew merges where both sides changed the same files; comes back as a pull   | yes    |

Answers are JSON in a text block; most carry a `says` sentence short enough
to relay as it is.

## Connecting

Mint a token under **Settings → Access tokens** (`rw` to act, `ro` to watch),
then, in Claude Code:

```sh
claude mcp add --transport http forge https://<your-forge>/mcp \
  --header "Authorization: Bearer <token>"
```

Any MCP client that can send a header works the same way. The Claude apps on
the web and the phone add custom connectors through OAuth, which the forge
does not speak yet; that is the next step here, and it changes nothing above
— the same tools, a token the forge mints for the connector instead of one a
person pastes.

`src/http/mcp.ts`, `src/actions/tell.ts`, `test/mcp.test.ts`.
