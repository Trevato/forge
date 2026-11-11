# App manifest: forge.json and its life cycle

Version: 1

An app is a git repository whose root says how it runs. A forge reads the file
from the commit being deployed, never from its own database.

## Wire format

`forge.json` at the repository root (JSON). Only `app.run` matters to start;
every other key is optional.

```json
{
  "app": {
    "run": "bun run src/server.ts",
    "install": "bun install",
    "test": "bun test",
    "health": "/healthz",
    "ready": 30,
    "looks": ["/"]
  },
  "egress": ["api.example.com"],
  "toolbar": true
}
```

- `app.run`: shell-free command line that starts the server. Without a
  `forge.json`, a `package.json` `start` script stands in.
- `app.install`, `app.test`: commands run before `run`; `test` must pass before
  a deploy is live.
- `app.health`: path polled until it answers 2xx; `app.ready`: seconds to wait.
- `egress`: the only hosts the app may reach besides the forge.
- Unknown keys are ignored by apps and must not be required by a forge.

## Life cycle

1. Production is the default branch; every open pull gets a preview from its
   branch, redeployed on each push, gone when the pull closes.
2. The forge starts `run` with `PORT`, `FORGE_APP_DATA` (the only place the app
   may write), `FORGE_URL` and `FORGE_APP_IDENTITY_KEY` in its environment.
3. The app is ready when `health` answers 2xx within `ready` seconds; otherwise
   the deploy fails.

## An app must

- listen on `PORT` and answer its `health` path with 2xx;
- keep state under `FORGE_APP_DATA` only;
- answer `GET /healthz` with `{"ok": true, …}` when it has no other health path.

## A forge must

- read the manifest from the deployed commit;
- run the app's `test` before it serves a deploy;
- never let an agent move the default branch.

Suite: `standards/app.test.ts` (health), `standards/forge.test.ts`
(a committed `forge.json` is plain JSON of the shape above).
