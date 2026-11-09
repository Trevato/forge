# Adapters

This document states the contract for an adapter: an app that copies records
from an external system into its own data on a schedule. It is for anyone who
writes an adapter, person or agent, and it is meant to be read before any code
exists. The key idea: an adapter declares its schedule and its source hosts in
`forge.json`, answers one request, `POST /pull`, with four fields, and gives the
same result each time it is called with the same cursor. The forge checks the
answer and records each pull as a run.

## Status

This is the contract, not a description of running code. Today the forge does
not read the `adapter` block and does not call `POST /pull`. The answer's
checks and the pull run record exist (`src/apps/pull.ts`: `parsePullAnswer`,
`recordPull`, kept in the `pull_run` table), but nothing calls them yet. An
adapter written to this page is an ordinary app until that work lands. The rest of the forge's app rules apply to it now: see
[`docs/APPS.md`](APPS.md).

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
- `source.name` is the external system's name, as people read it.
- `source.hosts` lists the hosts the adapter reads from.

A block that breaks any of these rules is invalid, and the forge does not
schedule the app.

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
