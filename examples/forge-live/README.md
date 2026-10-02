# forge-live

A page inside an app that is live UI into the forge it runs on: what the
crew is doing **now**, refreshed as the forge's `/events` stream moves, with
a **say** link beside each run.

## How it reads the forge

Every app and preview process the forge starts is given:

| variable        | what it is                                                       |
| --------------- | ---------------------------------------------------------------- |
| `FORGE_URL`     | the forge: `POST /mcp` (tools such as `now`), `GET /events`      |
| `FORGE_API_URL` | the JSON API, `FORGE_URL` + `/api/v1`                            |
| `FORGE_TOKEN`   | read-only, the repository owner's; revoked when the process stops |

The server calls the MCP tool `now` with the token and renders the list.
`/live` opens the forge's `/events` with the same token and passes on only
the fact that something changed; the browser refetches `/now`. The token and
the events' contents never leave this server.

## Assumptions

- The token reads everything the app's owner may read. Whoever the app's
  `access` lets in sees the list, so keep a page like this behind
  `access: private` unless the crew's work is meant to be public.
- **say** is a link to the issue on the forge, not a form here: the token is
  read-only by design, and a page any visitor can load must not speak in the
  owner's name. The person says it on the forge, as themselves.

## Run it

Make these files the root of an app's repository (or copy them into one) and
push; the forge deploys it. Locally, outside the forge, the page says it has
no token.

Zero dependencies.
