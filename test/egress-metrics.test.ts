import { expect, test } from "bun:test";
import { egressMetrics } from "../src/apps/egress_metrics.ts";

test("every destination gets its open count and bytes, labels escaped", () => {
  const text = egressMetrics([
    { label: 'a/"b"', destination: "pi:8080", open: 3, bytesIn: 10, bytesOut: 2 },
  ]);
  expect(text).toContain('forge_egress_connections{repo="a/\\"b\\"",destination="pi:8080"} 3');
  expect(text).toContain('forge_egress_bytes_in{repo="a/\\"b\\"",destination="pi:8080"} 10');
  expect(text).toContain('forge_egress_bytes_out{repo="a/\\"b\\"",destination="pi:8080"} 2');
});

test("no connections leaves only the headers", () => {
  expect(egressMetrics([])).not.toContain("{");
});
