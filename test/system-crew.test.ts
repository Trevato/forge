import { expect, test } from "bun:test";
import type { Proc, Raw } from "../src/system/proc.ts";
import { buildSystem, forAgent } from "../src/system/view.ts";

const proc = (pid: number, ppid: number): Proc => ({ pid, ppid, comm: "bun", ticks: 0, rss: 1 << 20, age: 5, tests: [] });
const raw: Raw = {
  at: 1_000, cores: [], temps: [], load: null, memory: null, disks: [], net: [], io: [],
  procs: [proc(1, 0), proc(300, 1), proc(301, 300), proc(302, 301)],
};

test("a crew run's tree is a crew:<name> group, hidden by name from agents", () => {
  const view = buildSystem(undefined, raw, [{ label: "crew:scout", root: 300 }], 1);
  const g = view.groups.find((x) => x.label === "crew:scout")!;
  expect(g.kind).toBe("crew");
  expect(g.procs).toBe(3);
  expect(view.groups.find((x) => x.label === "forge")!.procs).toBe(1);
  const seen = forAgent(view, () => false).groups.find((x) => x.kind === "crew")!;
  expect(seen.label).toBe("crew:private-1");
  expect(seen.top).toEqual([]);
});
