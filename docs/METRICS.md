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
