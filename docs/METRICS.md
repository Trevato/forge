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
| `forge_http_request_duration_seconds` | histogram | `pattern` (plus `le`) | Seconds taken to answer a request, by the route pattern matched (never the raw path), since the process started. Buckets are `route_timing`'s edges, 1 ms to 2.5 s, in seconds. |
| `forge_app_up` | gauge | `app`, `env` | 1 when the app environment is serving, 0 when it is asleep, stopped, deploying or failed. |
| `forge_cell_cpu_seconds` (samples `forge_cell_cpu_seconds_total`) | counter | `app`, `env` | CPU seconds (user plus system) used by the processes of a running app cell. |
| `forge_cell_memory_bytes` | gauge | `app`, `env` | Resident memory of the processes of a running app cell. |

`app` is the app's slug, or its id for a private app: a private app's name is
never in the body. `env` is `production` or `pull-<n>`. The cell families are
what the cell watch last read (every few seconds); a cell that is not running
has no series (a cell keeps the slug it started under, so after a rename its figures return when it restarts), and the forge starts nothing and reads no process to answer.

The duration histogram counts every request the process has answered since
it started; its `_bucket`, `_count` and `_sum` only grow, so `rate()` and
`histogram_quantile()` read it as Prometheus expects. A restart starts it at
zero again, which Prometheus reads as a counter reset. A request counts the
moment it is answered. The hourly `route_timing` table, which keeps 30 days,
is the place to look further back.

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
