# Metrics

`GET /metrics` answers Prometheus text (`text/plain; version=0.0.4`), one
format for the whole body. It names repositories and route patterns, so it is
for a site admin alone: 404 without credentials and for anyone else who is
not an admin, 200 for an admin's `ro` token. It is never cached
(`cache-control: no-store`).

| Family | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `forge_egress_connections` | gauge | `repo`, `destination` | Open egress connections. |
| `forge_egress_bytes_in` | gauge | `repo`, `destination` | Bytes received from the destination over open connections. |
| `forge_egress_bytes_out` | gauge | `repo`, `destination` | Bytes sent to the destination over open connections. |
| `forge_egress_received_bytes_total` | counter | `destination` | Bytes received from the destination since the process started, every app and check together. |
| `forge_egress_sent_bytes_total` | counter | `destination` | Bytes sent to the destination since the process started. |
| `forge_http_request_duration_seconds` | histogram | `pattern` (plus `le`) | Seconds taken to answer a request, by the route pattern matched (never the raw path), since the process started. Buckets are `route_timing`'s edges, 1 ms to 2.5 s, in seconds. |
| `forge_check_duration_seconds` | histogram | (plus `le`) | Seconds a repository check took from start to finish, for checks that ended since the process started. Buckets 5 s to 30 min. |
| `forge_check_queue_depth` | gauge | none | Checks queued and not yet started. |
| `forge_crew_runs_total` | counter | `member`, `outcome` | Crew runs that ended, by the member's username and `ok`, `failed` or `cancelled`. |
| `forge_crew_spend_usd_total` | counter | `member` | US dollars the member's runs spent, from the usage ledger (list-price equivalent on a subscription). |
| `forge_pulls_merged_total` | counter | `repo` | Pulls merged, from `pull.merged_at`. |
| `forge_releases_total` | counter | none | Releases that went live, from the `release` table's `ok` rows. |
| `forge_ask_to_live_seconds` | histogram | none (plus `le`) | Seconds from an issue opening to the first successful release of a pull that closes it. Buckets: 1 m, 5 m, 15 m, 1 h, 4 h, 12 h, 1 d, 3 d, 7 d. |
| `forge_main_red_seconds_total` | counter | `repo` | Seconds the default branch's check spent failing: from a failed check to the next green one, or to now while still red. |
| `forge_telemetry_reads_total` | counter | `route`, `reader` | Reads of `/api/v1/telemetry` routes since the process started, by route and reader; the rate is the slope. |
| `forge_app_up` | gauge | `app`, `env` | 1 when the app environment is serving, 0 when it is asleep, stopped, deploying or failed. |
| `forge_cell_cpu_seconds` (samples `forge_cell_cpu_seconds_total`) | counter | `app`, `env` | CPU seconds (user plus system) used by the processes of a running app cell. |
| `forge_cell_memory_bytes` | gauge | `app`, `env` | Resident memory of the processes of a running app cell. |

`app` is the app's slug, or its id for a private app: a private app's name is
never in the body. `env` is `production` or `pull-<n>`. The cell families are
what the cell watch last read (every few seconds); a cell that is not running
has no series (a cell keeps the slug it started under, so after a rename its figures return when it restarts), and the forge starts nothing and reads no process to answer.

The duration histograms count every request the process has answered, and
every check it has seen finish, since it started; their `_bucket`, `_count`
and `_sum` only grow, so `rate()` and `histogram_quantile()` read them as
Prometheus expects. A restart starts them at zero again, which Prometheus
reads as a counter reset. A request counts the moment it is answered; a check
counts at the first scrape after it finishes. The hourly `route_timing` table,
which keeps 30 days, is the place to look further back.

The delivery series are read from the `pull`, `release` and `run` tables on
every scrape, so the scrape cost grows with those tables. The check histogram
reads only the checks finished since the last scrape, through the
`run_kind_finished` index; the queue and crew series are small grouped reads.

A public repository's `repo` label is `owner/name`; a private one appears
under its id only, never its name.

## Prometheus

Make an admin `ro` token in your account settings, then:

```yaml
scrape_configs:
  - job_name: forge
    scheme: https
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/forge-token
    static_configs:
      - targets: ["forge.example.com"]
```

`GET /metrics` (site admin only; repository names are in the labels) serves
`forge_egress_connections`, `forge_egress_bytes_in` and `forge_egress_bytes_out`
per `repo` and `destination` as Prometheus text, so a leaked upstream socket
shows as a gauge that never falls (#3719).

Beside them, `forge_egress_received_bytes_total` and `forge_egress_sent_bytes_total`
count every byte since the process started, keyed by `destination` alone (never
by run, so the series stay one per host). They show the bun cache working
(#7546): on a warm cache,
`rate(forge_egress_received_bytes_total{destination="registry.npmjs.org:443"}[1h])`
stays near zero, and a cold one is hundreds of megabytes an hour (#7541).
Without Prometheus, the same hour is read four ways:

- MCP `capacity` (forge admin) answers `egress.npmBytesLastHour`,
  `egress.npmTopRepoLastHour` (the repository whose contained installs the
  registry sent most this hour, attributed by the cell's own meter, never by
  install output; null when none) and the ten busiest `egress.destinations`
  with their totals and last hour.
- `/settings/capacity` prints it, with the top repository, in the Egress
  connections card.
- The terminal's Egress connections screen (About, `c`, site admin) prints the
  same line, with the top repository, above the open connections; all three
  read `egressHour`.
- Each check's install step in a cell logs one line, `install fetched 0 B from
  the registry` on a warm cache: what the cell's egress proxy received. A check
  outside a cell logs none: its repository's bun cache is shared, so no figure
  there would be its own. A contained check, gate or app install that received
  more than 1 MiB from `registry.npmjs.org` ends its log with `install fetched
  N MiB from the npm registry; the shared cache missed` (#8382), failed or
  aborted installs included.
