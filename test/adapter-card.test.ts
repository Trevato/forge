import { expect, test } from "bun:test";
import { adapterCardView, everyWords } from "../src/web/studio/adapter.ts";
import { adapterRows } from "../src/apps/adapter_facts.ts";
import type { PullRun } from "../src/core/runs.ts";

const spec = { schedule: { every: 900 }, source: { name: "Shop <b>API</b>", hosts: ["api.shop.example"] } };
const run = (over: Partial<PullRun>): PullRun => ({
  id: "r", appId: "a", kind: "pull", state: "ok", written: 3, skipped: 2, failed: 1,
  cursor: "c9", durationMs: 5, reason: "", repeat: false, createdAt: "2026-11-09T10:00:00.000Z", ...over,
});
const now = Date.parse("2026-11-09T10:05:00.000Z");

test("the card shows source, last pull, next pull and cursor", () => {
  const out = String(adapterCardView({ spec, last: run({}), cursor: "c9" }, now));
  expect(out).toContain("Shop &lt;b&gt;API&lt;/b&gt;");
  expect(out).toContain("3 written, 2 skipped, 1 failed");
  expect(out).toContain("in 10 minutes");
  expect(out).toContain("<code>c9</code>");
});

test("a failed pull shows its reason, escaped, and a hostile cursor stays text", () => {
  const out = String(adapterCardView({ spec, last: run({ state: "failed", reason: "<script>x</script>" }), cursor: "<img>" }, now));
  expect(out).not.toContain("<script>");
  expect(out).not.toContain("<img>");
  expect(out).toContain("&lt;script&gt;");
});

test("before the first pull the card says so", () => {
  const out = String(adapterCardView({ spec, last: undefined, cursor: undefined }, now));
  expect(out).toContain("Not yet");
  expect(out).toContain("None yet");
  expect(everyWords(3600)).toBe("1 hour");
});

test("the terminal rows read the same facts as the card", () => {
  const rows = Object.fromEntries(adapterRows({ spec, last: run({}), cursor: "c9" }, now));
  expect(rows["Source"]).toBe("Shop <b>API</b>");
  expect(rows["Last pull"]).toContain("3 written, 2 skipped, 1 failed");
  expect(rows["Next pull"]).toContain("in 10 minutes");
  expect(rows["Cursor"]).toBe("c9");
  expect(Object.fromEntries(adapterRows({ spec, last: undefined, cursor: undefined }, now))["Last pull"]).toBe("Not yet");
});

test("the card is plain rows under an h2, not a boxed card", () => {
  const out = String(adapterCardView({ spec, last: undefined, cursor: undefined }, now));
  expect(out).toContain("<h2>Adapter</h2>");
  expect(out).not.toContain("card");
});

const line = (over: object) => ({ id: "r", at: "2026-11-09T10:00:00.000Z", durationMs: 5, state: "ok" as const, error: null, written: 3, skipped: 2, failed: 1, cursor: "c", repeat: false, ...over });
const bare = { spec, last: undefined, cursor: undefined };

test("the card lists the runs, a failed one's error escaped, under one always-present heading", () => {
  const out = String(adapterCardView({ ...bare, runs: [line({}), line({ state: "failed", error: "<script>x</script>" })] }, now));
  expect(out).toContain("<h3>Pull runs</h3>");
  expect(out.match(/<li /g)?.length).toBe(2);
  expect(out).toContain("3 written, 2 skipped, 1 failed");
  expect(out).toContain("&lt;script&gt;x");
  expect(out).not.toContain("<script>");
});

test("with no runs the same heading carries one muted line", () => {
  for (const facts of [bare, { ...bare, runs: [] }]) {
    const out = String(adapterCardView(facts, now));
    expect(out).toContain("<h3>Pull runs</h3>");
    expect(out).toContain("No pull runs yet.");
    expect(out).not.toContain("<li");
  }
});
