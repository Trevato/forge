# adapter-template

A working adapter to copy: it pulls records from one external system into its
own bun:sqlite file and answers the forge's `POST /pull` with
`{pulled, skipped, cursor, errors}`. The contract it follows is
[`docs/ADAPTERS.md`](../../docs/ADAPTERS.md). Zero dependencies.

## Files

| file            | what it holds                                                        |
| --------------- | -------------------------------------------------------------------- |
| `forge.json`    | how the forge runs it: `egress` opens the source host, `adapter.schedule` sets the interval |
| `src/source.ts` | the source: its name and hosts, the only `fetch` the adapter uses, and how a page and a record are read |
| `src/store.ts`  | records keyed by the source's id, and the cursor, under `FORGE_APP_DATA/adapter.sqlite` |
| `src/pull.ts`   | one pull: read the page after the cursor, write what is new, move the cursor, count |
| `src/server.ts` | `POST /pull` (admins only), `GET /` (what is held, to admins), `GET /healthz` |
| `src/who.ts`    | who is asking, from the forge's signed `x-forge-identity` headers     |
| `test/`         | a replay writes nothing new; a host outside the source is refused; only a signed admin may pull |

## Make it yours

1. In `src/source.ts`, set `SOURCE.name` and `SOURCE.hosts`, the URL in
   `readPage`, and `parseRecord` for your system's records. Keep each
   record's key the source's own id: that is what makes a replay a no-op.
2. In `forge.json`, put the same hosts in `egress`, and pick
   `adapter.schedule.every` (60 to 86400 seconds).
3. `bun test`.

## Rules it keeps

- **Idempotent.** A record is written under its source id and only when it is
  new or changed; records and the cursor land in one transaction. A pull from
  the same cursor counts what it already holds as `skipped`.
- **Only its source.** `sourceFetch` refuses any host not in `SOURCE.hosts`,
  any scheme but `https`, and does not follow redirects. `egress` is the
  forge's lock on the same door; this is the adapter's own.
- **Only an admin pulls.** A pull reaches out to the source and writes, so
  `POST /pull` first checks the forge's signed `x-forge-identity` and
  `x-forge-signature` against `FORGE_APP_IDENTITY_KEY` (`src/who.ts`: HMAC,
  constant-time compare, expiry in the future). No headers, a bad signature or
  an expired one answers 401; a signed `user` answers 403. Neither reads the
  source. Without the key nobody may pull.
- **A failed pull moves nothing.** The answer is a fixed 502 `pull failed`
  and the cursor stays; the detail, which can name the source's host or URL,
  goes to the log only.
- **The page tells visitors only the adapter's name.** `GET /` shows the
  cursor, record count and last pull to admins only, since a cursor can be a
  source's page token.
- **One pull at a time.** A second `POST /pull` waits for the first.
- A browser `POST /pull` from another origin is refused; every response sets
  `Content-Security-Policy`, `X-Content-Type-Options` and `Referrer-Policy`.

## Try it

```sh
key=$(openssl rand -hex 16)
FORGE_APP_DATA=$(mktemp -d) FORGE_APP_IDENTITY_KEY=$key PORT=3000 bun run src/server.ts &
id="me|me|admin|$(( $(date +%s) * 1000 + 600000 ))"
sig=$(printf %s "$id" | openssl dgst -sha256 -hmac "$key" -binary | base64 | tr '+/' '-_' | tr -d '=')
curl -X POST -H "x-forge-identity: $id" -H "x-forge-signature: $sig" localhost:3000/pull
```

Run under the forge, the forge signs those headers itself. `api.example.com`
is a placeholder, so the pull answers 502 until `src/source.ts` names a real
source.
