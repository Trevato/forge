/**
 * The egress tally as Prometheus text (#3719): one line per app and
 * destination for open connections and the bytes they have moved, so a leaked
 * upstream socket shows as a gauge that never falls.
 */
import type { EgressRow } from "./egress.ts";

/** A label value, escaped as the exposition format asks. */
function label(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function egressMetrics(rows: readonly EgressRow[]): string {
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
  return `${lines.join("\n")}\n`;
}
