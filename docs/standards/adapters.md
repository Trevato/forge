# Adapters: POST /pull

Version: 1

An adapter is an app that copies records from an external system into its own
data on a schedule.

## Wire format

Declared in `forge.json`:

```json
{
  "egress": ["api.example.com"],
  "adapter": {
    "source": { "name": "Example CRM", "hosts": ["api.example.com"] },
    "schedule": { "every": 3600 }
  }
}
```

`schedule.every` is an integer from 60 to 86400 seconds; every `source.hosts`
entry must also be in `egress`; unknown keys are refused. On schedule the forge
sends `POST /pull` (signed as an `admin`, see identity) and the app answers
exactly four fields:

```json
{ "pulled": 12, "skipped": 3, "cursor": "2026-11-09T07:00:00Z", "errors": 0 }
```

`pulled`, `skipped`, `errors`: integers 0–1,000,000. `cursor`: one printable
line of at most 200 characters.

## An adapter must

- answer 401/403 to a `POST /pull` without a valid signed `admin` identity and
  read nothing from its source then;
- be idempotent: the same cursor gives the same result and writes nothing new
  (a repeat counts records as `skipped`);
- advance the cursor only after the records it covers are written.

## A forge must

- pull only a running app, never wake one, never overlap two pulls of an app;
- record a bad answer (non-2xx, wrong fields, out of range) as a failed run,
  keep the previous cursor, and pause an adapter after 5 failed runs in a row;
- expose runs at `GET /api/v1/repos/:o/:n/app/pulls` (`{items}`), readable only
  by who may read the repository.

Suite: `standards/app.test.ts` with `APP_ADAPTER=1` (unsigned pull refused);
`standards/forge.test.ts` (runs not readable anonymously).
