/**
 * The egress tally as Prometheus text (#3719): one line per app and
 * destination for open connections and the bytes they have moved, so a leaked
 * upstream socket shows as a gauge that never falls. Beside them, counters of
 * every byte moved since the forge started, per destination alone (#7546):
 * `rate(forge_egress_received_bytes_total{destination="registry.npmjs.org:443"}[1h])`
 * is the bun cache working, or not.
 */
import type { EgressRow, EgressTotal } from "./egress.ts";

/** A label value, escaped as the exposition format asks. */
function label(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function egressMetrics(rows: readonly EgressRow[], totals: readonly EgressTotal[] = []): string {
  const series: [string, string, (r: EgressRow) => number][] = [
    ["forge_egress_connections", "Open egress connections.", (r) => r.open],
    ["forge_egress_bytes_in", "Bytes received from the destination over open connections.", (r) => r.bytesIn],
    ["forge_egress_bytes_out", "Bytes sent to the destination over open connections.", (r) => r.bytesOut],
  ];
  const lines: string[] = [];
  for (const [name, help, value] of series) {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const r of rows)
      lines.push(`${name}{repo="${label(r.label)}",destination="${label(r.destination)}"} ${value(r)}`);
  }
  const counters: [string, string, (t: EgressTotal) => number][] = [
    ["forge_egress_received_bytes", "Bytes received from the destination since the forge started.", (t) => t.bytesIn],
    ["forge_egress_sent_bytes", "Bytes sent to the destination since the forge started.", (t) => t.bytesOut],
  ];
  for (const [name, help, value] of counters) {
    // A counter's family is named without `_total`; its samples carry it.
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
    for (const t of totals) lines.push(`${name}_total{destination="${label(t.destination)}"} ${value(t)}`);
  }
  return `${lines.join("\n")}\n`;
}
