# Metrics

`GET /metrics` answers Prometheus text (`text/plain; version=0.0.4`), one
format for the whole body. It names repositories and route patterns, so it is
for a site admin alone: 401 without credentials, 404 for anyone else, 200 for
an admin's `ro` token. It is never cached (`cache-control: no-store`).

| Family | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `forge_egress_connections` | gauge | `repo`, `destination` | Open egress connections. |
| `forge_egress_bytes_in` | gauge | `repo`, `destination` | Bytes received from the destination over open connections. |
| `forge_egress_bytes_out` | gauge | `repo`, `destination` | Bytes sent to the destination over open connections. |
| `forge_http_request_duration_seconds` | histogram | `pattern` (plus `le`) | Seconds taken to answer a request, by the route pattern matched (never the raw path), over the last hour. Buckets are `route_timing`'s edges, 1 ms to 2.5 s, in seconds. |

The duration histogram is read from the hourly `route_timing` table, so it
covers the current hour and the one before; requests are written within about
a second.

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
