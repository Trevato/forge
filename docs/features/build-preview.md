# Build preview

Look at any one commit of an app, now, without pinning it or opening a pull.
It runs at `<slug>--b<sha7>.<domain>` with a copy of production's data, the
way a pull's preview does. A writer who is a person may ask (verified email;
never an agent; not on a mirror). Nothing is stored: the forge holds at most
three per app in memory, the oldest giving way to a newer one, and a restart
removes them.

## From the terminal

Open the app's **Deploys** screen (palette, then the app's deploys). Press
`b`, type the commit's full 40-character id, press Enter. A line names the
address, or says why not (the same words as below). The key is offered only to
a writer who is a person.

## From the API

```
POST /api/v1/repos/<owner>/<name>/builds/preview
authorization: Bearer <token with rw scope>
{"sha": "<40-character commit id>"}
```

201 answers `{ "env": "build-1a2b3c4", "url": "…" }`. 422 is a refusal
(`forbidden`, `unverified`, `mirrored`, `not_a_commit`, `no_runtime`,
`not_found`); 429 is `rate_limited`.

## The limit

Each new build can tear down the oldest and starts a deploy, so one person may
ask 20 times per app in ten minutes (`BUILD_ASKS_MAX`,
`BUILD_ASKS_WINDOW_MS` in `actions/build_preview.ts`), counted by their
identity. Asking again for a build already running costs the same ask and
redeploys nothing.

Try it: on a preview, `POST` a commit of the app to the route above and open
the returned `url`.
