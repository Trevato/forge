# Adapters

This document states the contract for an adapter: an app that copies records
from an external system into its own data on a schedule. It is for anyone who
writes an adapter, person or agent, and it is meant to be read before any code
exists. The key idea: an adapter declares its schedule and its source hosts in
`forge.json`, answers one request, `POST /pull`, with four fields, and gives the
same result each time it is called with the same cursor. The forge checks the
answer and records each pull as a run.

## Status

The forge runs this contract today. Once a minute it checks every app
(`src/apps/pull_schedule.ts`). If an app's production is running, its
`forge.json` on the default branch has a valid `adapter` block
(`src/apps/adapter.ts`), and its schedule is due, the forge sends that app
`POST /pull`. The forge never wakes a sleeping app to pull it. Two pulls of
the same app never overlap. The forge judges each answer and records it as a
pull run in the `pull_run` table (`src/apps/pull.ts`: `parsePullAnswer`,
`recordPull`), whether the answer is good or failed.

The call is signed as an `admin` the forge vouches for (see "The template"
below), so an adapter that admits only a signed `admin` answers it.

The API reads the recorded runs: `GET /api/v1/repos/:owner/:name/app/pulls`
answers `{ items }`, the app's last pull runs newest first (`?limit=` 1–100,
default 20). Each says when (`at`), how long (`durationMs`), `ok` or `failed`
(`state`), the sentence saying why when it failed (`error`), the records
`written`, `skipped` and `failed`, the `cursor` after it (null after a failed
pull) and whether it was a `repeat`. Whoever may read the repository may read
them; anyone else gets 404. The rows come through `pullRunLines` in
`src/apps/pull.ts`, so a page or MCP can read them the same way. MCP `apps` with
`{ repo, pulls: true, limit? }` answers the same `{ items, next_cursor }` through
the same function; a stranger, or a repository with no app, gets `not_found`.

The rest of the forge's app rules apply to an adapter as they apply to any
other app: see [`docs/APPS.md`](APPS.md).

## The template

[`examples/adapter-template/`](../examples/adapter-template/) is a working
adapter to copy. It has no dependencies, answers `POST /pull`, keeps its
records and cursor in bun:sqlite under `FORGE_APP_DATA`, and refuses any host
outside its source. Its README says what to change. Its tests prove that a
replay writes nothing new and that another host is refused. The forge's check
runs them through `test/adapter-template.test.ts`, which also parses the
template's `forge.json` and checks that each source host is in `egress`.

The template accepts `POST /pull` only from an `admin` the forge signed for:
`x-forge-identity` and `x-forge-signature`, checked against
`FORGE_APP_IDENTITY_KEY` (see "Who is there" in [`docs/APPS.md`](APPS.md)).
Anyone else gets 401 or 403, and the source is not read, so a public app or
a preview cannot be made to pull by whoever reaches it. The forge's scheduled
call carries that signed identity: `src/apps/pull_schedule.ts` signs it as an
`admin` named `forge`, under the app's identity key, the same way the proxy
signs a person, and good only for the 10 s it waits. The key itself is never
sent.

The template names its source hosts in `src/source.ts` and opens them with
`egress`. Its `adapter` block may also name them under `source`, which the
parser reads; each must then be in `egress` as well.

## The `adapter` block in forge.json

An app declares itself an adapter with an optional top-level `adapter` block:

```json
{
  "egress": ["api.example.com"],
  "app": { "run": "bun run src/server.ts" },
  "adapter": {
    "source": { "name": "Example CRM", "hosts": ["api.example.com"] },
    "schedule": { "every": 3600 }
  }
}
```

- `schedule.every` is the interval between pulls, in seconds. It is an
  integer from 60 to 86400, which is one minute to one day.
- `source` is optional: `source.name` is the external system's name, as
  people read it, and `source.hosts` lists the 1 to 8 hosts the adapter reads
  from, each a bare lowercase host name.
- `config` is optional: the settings the adapter reads, each named by the
  environment variable it comes from, with a `type` of `string`, `number`,
  `boolean` or `secret`, and `required` or a `default`. A `secret` names a
  variable and never holds a value. A field may not name a variable the
  forge sets itself.

Any other key, at any level, is refused. A block that breaks any of these
rules is invalid, and the forge does not schedule the app.

## Pull now

A writer need not wait for `schedule.every` to see a pull:
`POST /api/v1/repos/:owner/:name/app/pull`, or the MCP tool `app_deploy` with
`{ repo, action: "pull" }`, runs one pull through the schedule's own path
(`pullAppNow` in `src/apps/pull_schedule.ts`, `src/actions/app_pull.ts`) and
answers `{ run }`, the recorded pull run. It is refused 404 when the default
branch's `forge.json` has no valid `adapter` block, and 409 when a pull of
the app is already in flight or its production is not running. A sleeping
app is refused, never woken.

## Source hosts and egress

Every host in `source.hosts` must also appear in the top-level `egress` list.
`egress` is what the forge's proxy lets the app reach (see the egress section
of [`docs/APPS.md`](APPS.md)). A source host missing from `egress` makes the
block invalid. Declaring a host in `source.hosts` does not open it; only
`egress` opens a host.

## The `POST /pull` request and its answer

On each scheduled time the forge sends `POST /pull` to the app. The adapter
reads from its source, writes what is new under `FORGE_APP_DATA`, stores its
cursor there, and answers with a JSON object of exactly these four fields:

```json
{ "pulled": 12, "skipped": 3, "cursor": "2026-11-09T07:00:00Z", "errors": 0 }
```

- `pulled` is the number of records written by this pull.
- `skipped` is the number of records read and not written, because they were
  already present or did not apply.
- `errors` is the number of records that failed.
- `cursor` is the position the next pull starts from.

`pulled`, `skipped` and `errors` are integers from 0 to 1,000,000. `cursor` is
one line of at most 200 printable characters: no line breaks and no control
characters. The format inside the cursor belongs to the adapter; a timestamp,
a page token or a record id all work.

## What idempotent means

A pull is idempotent. A pull that starts from the same cursor gives the same
result and writes nothing new. If the forge repeats a pull, for example after
a timeout, the second pull counts the records it already holds as `skipped`,
not `pulled`. An adapter meets this rule by writing each record under a key
taken from the source, such as the source's record id, and by advancing the
cursor only after the records it covers are written.

## What the forge does with a bad answer

An answer is bad when the request fails, the status is not 2xx, the body is not
a JSON object with exactly the four fields, or any field breaks its rule above.
For a bad answer the forge:

- records the run as failed, with a reason that names what was wrong, such as
  `pulled is not an integer from 0 to 1000000`;
- keeps the previous cursor, so the next pull starts from the last good
  position;
- does not wake the app to pull again until the next scheduled time.

A good answer is recorded as a run with its counts, its cursor and its
duration.

The schedule is kept by `src/apps/pull_schedule.ts`: once a minute the forge
pulls each app whose production is running, whose `forge.json` on the default
branch has an `adapter` block, and whose last pull, good or failed, is at least
`schedule.every` seconds old. A sleeping app is never woken to be pulled; it is
pulled on the first minute it is running and due. The request goes over
loopback, waits at most 10 seconds and reads at most 64 KB. Two pulls of the
same app never overlap.
