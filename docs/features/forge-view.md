# The forge view (`GET /api/v1/forge/view`)

One read for a reader that draws the forge — foundry (`trevato/foundry`, a live 3D model) is the first. It is on the
public API and in the OpenAPI document like any route; there is no private door for it. It is the forge's own reads
composed, so its numbers are the ones home and the board show.

```json
{ "counts": { "apps": 12, "running": 2, "queued": 1, "waiting": 0 },
  "apps":   [{ "app": "ada/hello", "slug": "hello", "access": "public", "running": 1, "queued": 0 }],
  "runs":   [ /* the rows of GET /api/v1/crew/now: run, app, who, on, why, state, since, costUsd */ ],
  "health": { /* GET /api/v1/health, as it answers this caller */ },
  "at": "2026-11-02T10:00:00.000Z" }
```

- **Stations.** Each run's `state` (`queued`, `running`) and `why` are where it stands; `waiting` counts the rows that
  wait on a person (`run: null`). Per-app `running`/`queued` are the same rows grouped.
- **Who sees what.** The caller's own visibility: private apps, sealed reports and owner-only facts follow the same
  checks as `/api/v1/crew/now` and `/api/v1/apps`. Health is the stranger/signed-in/admin tiers of `/api/v1/health`.
- **Read-only.** Any token scope (`ro` included) reads it; the route accepts GET only (other methods are 404/405), and
  a `ro` token is refused on the forge's writes as everywhere.
- **Cheap to leave on.** The answer is built at most once per two seconds per caller (`VIEW_TTL_MS`), carries an
  `ETag` that ignores `at`, and a poll that holds it gets a 304. Lists are bounded: queued and running runs at 50 (the `LIMIT 50` of `listActiveRuns`, which `crewNow` reads), the
  rows waiting on a person by what `crewNow` finds, and apps at 200 (`VIEW_APPS`; `counts.apps` is still the true number). Poll every
  2–5 s; there is no stream, deliberately, so an always-on view adds no connection to hold (#7559).

**MCP.** The `forge_view` tool (read-only, no arguments) answers the same body for the same caller, from the same two-second build.

**Links.** Home (the apps card) and the command palette show **Foundry** when an app with the slug `foundry` is
installed and the reader may enter it (`actions/foundry_door.ts`). The slug is not enough: the app must be owned by
a site admin or by the `trevato` org, so nobody can plant a "Foundry" link by naming an app first. Nothing in the
forge depends on it.

**Terminal.** The palette's **Forge view** opens a screen with the view's counts and the Foundry address (when there
is a door); Enter opens Foundry on the web.

Not done: a push stream (`/api/v1/forge/view` is polled), and anything that writes.
