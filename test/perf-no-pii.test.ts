import { expect, test } from "bun:test";
import { createPerfRecord } from "../src/perf/record.ts";

test("only route patterns are keys: paths with queries, spaces or no slash are dropped", () => {
  const r = createPerfRecord();
  const s = { at: 1, ms: 1, signedIn: false, phases: [] };
  r.add("/alice/secret?token=abc", s);
  r.add("/alice x", s);
  r.add("alice", s);
  r.add("/:owner/:name", s);
  expect(r.patterns()).toEqual(["/:owner/:name"]);
});
test("a sample holds timings and signed-in or not, nothing of the viewer", () => {
  const r = createPerfRecord();
  r.add("/", { at: 1, ms: 2, signedIn: true, phases: [{ name: "app", ms: 1, hit: false }] });
  expect(Object.keys(r.traffic("/", 0)[0]!).sort()).toEqual(["at", "ms", "phases", "signedIn"]);
});
