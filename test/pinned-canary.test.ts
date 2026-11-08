import { expect, test } from "bun:test";
import { canary, invalid, leftovers, table } from "../scripts/pinned-canary.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const o = { name: "c", account: "do", app: "o/n", source: "https://x/y.git", version: A, next: B, budget: 600 };

function fake(opts: { rollbackTo?: string; status?: number } = {}) {
  const seen: string[] = [];
  let clock = 0;
  const call = async (path: string) => {
    seen.push(path);
    clock += 100;
    const version = path.endsWith("/update") ? B : path.endsWith("/rollback") ? (opts.rollbackTo ?? A) : A;
    return { status: opts.status ?? 200, json: { version, state: "running", remote: "d1", volume: "v1" } };
  };
  return { call, seen, now: () => clock };
}

test("deploy, update, rollback are timed and the table totals them", async () => {
  const f = fake();
  const r = await canary(f.call, f.now, o);
  expect(r.failure).toBeUndefined();
  expect(f.seen).toEqual(["/api/v1/admin/pinned", "/api/v1/admin/pinned/c/update", "/api/v1/admin/pinned/c/rollback"]);
  expect(r.steps.map((s) => s.seconds)).toEqual([100, 100, 100]);
  expect(table(r)).toContain("| **total** | **300.0** (budget 600) |");
});

test("a rollback that lands on the wrong version fails the canary", async () => {
  const f = fake({ rollbackTo: B });
  expect((await canary(f.call, f.now, o)).failure).toContain("rollback: version");
});

test("an HTTP refusal stops at that step; a spent budget fails", async () => {
  const f = fake({ status: 422 });
  const r = await canary(f.call, f.now, o);
  expect(r.steps).toHaveLength(1);
  expect(r.failure).toContain("deploy: HTTP 422");
  const g = fake();
  expect((await canary(g.call, g.now, { ...o, budget: 250 })).failure).toContain("over the 250 s budget");
});

test("a thrown request ends the run and names the step", async () => {
  const r = await canary(async () => { throw new Error("ECONNRESET"); }, () => 0, o);
  expect(r.failure).toBe("deploy: ECONNRESET");
  expect(r.steps).toHaveLength(0);
  expect(leftovers(r)).toBe("droplets: none recorded; volumes: none recorded");
});

test("a response with no droplet id fails, and its volume is still named for cleanup", async () => {
  const call = async () => ({ status: 201, json: { version: A, state: "running", remote: "", volume: "v9" } });
  const r = await canary(call, () => 0, o);
  expect(r.failure).toBe("deploy: no droplet id recorded");
  expect(leftovers(r)).toBe("droplets: none recorded; volumes: v9");
});

test("leftovers lists the ids of the steps that ran", async () => {
  const f = fake({ rollbackTo: B });
  expect(leftovers(await canary(f.call, f.now, o))).toBe("droplets: d1; volumes: v1");
});

test("versions and source are checked before any paid call", () => {
  const ok = { version: A, next: "v1.2.3", source: "https://x/y.git" };
  expect(invalid(ok)).toBeUndefined();
  expect(invalid({ ...ok, version: "main" })).toContain("--version");
  expect(invalid({ ...ok, next: "abc123" })).toContain("--next");
  expect(invalid({ ...ok, next: A })).toContain("differ");
  expect(invalid({ ...ok, source: "http://x/y.git" })).toContain("https");
  expect(invalid({ ...ok, source: "git@x:y.git" })).toContain("https");
});
