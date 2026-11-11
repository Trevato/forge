import { expect, test } from "bun:test";
import { parseFeature } from "../src/apps/feature.ts";

const tools = { scan: { description: "Run a scan" }, latest: { description: "Last", writes: false } };
const parse = (schedule?: unknown) => parseFeature({ feature: { name: "Radar", tools, ...(schedule === undefined ? {} : { schedule }) } });
const refused = (schedule: unknown, text: string) => {
  const r = parse(schedule);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain(text);
};

test("absent schedule is empty", () => {
  const r = parse();
  expect(r.ok && r.value?.schedule).toEqual([]);
});

test("a valid entry carries its interval in ms", () => {
  const r = parse([{ tool: "scan", every: "1h" }, { tool: "latest", every: "1d" }]);
  expect(r.ok && r.value?.schedule).toEqual([{ tool: "scan", everyMs: 3_600_000 }, { tool: "latest", everyMs: 86_400_000 }]);
});

test("an unknown tool is refused, naming it", () => refused([{ tool: "nope", every: "1h" }], 'schedule entry 1: tool "nope"'));
test("an unknown interval is refused, naming the entry", () => refused([{ tool: "scan", every: "5m" }], "schedule entry 1 (scan): every is one of"));
test("more than 4 entries are refused", () => refused(Array(5).fill({ tool: "scan", every: "1h" }), "at most 4 entries"));
test("a non-array is refused", () => refused({ tool: "scan", every: "1h" }, "schedule must be a list"));
test("an entry with an extra field is refused", () => refused([{ tool: "scan", every: "1h", x: 1 }], "unknown field x"));
