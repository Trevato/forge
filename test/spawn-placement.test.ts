import { describe, expect, test } from "bun:test";
import { hostedPlacement, memoryBodies } from "../src/spawn/placement.ts";
import type { SpawnPlan } from "../src/spawn/plan.ts";

const plan = (name: string): SpawnPlan => ({ name, org: "o", apps: [], briefs: [], subscriptions: [], direction: "", keepAccess: false, keyCapUsd: null });
const make = (o: Partial<Parameters<typeof hostedPlacement>[0]> = {}) => {
  let n = 0;
  const store = memoryBodies();
  return { store, p: hostedPlacement({ host: "f.test", store, newId: () => `b${++n}`, ...o }) };
};

describe("hosted placement", () => {
  test("places a child as a subdomain of the parent, one agent, no SSH", async () => {
    const { p, store } = make();
    const r = await p.place(plan("kid"));
    expect(r).toEqual({ ok: true, value: { url: "https://kid.f.test", bodyId: "b1" } });
    expect(store.list()[0]).toMatchObject({ depth: 1, agents: 1, ssh: false });
  });

  test("refuses beyond the children limit, and retiring frees a slot", async () => {
    const { p } = make({ maxChildren: 2 });
    await p.place(plan("a"));
    const b = await p.place(plan("b"));
    const c = await p.place(plan("c"));
    expect(!c.ok && c.error.reason).toBe("children");
    if (b.ok) expect((await p.retire(b.value.bodyId)).ok).toBe(true);
    expect((await p.place(plan("c"))).ok).toBe(true);
  });

  test("refuses past the nesting depth", async () => {
    const { p, store } = make({ depth: 2, maxDepth: 2 });
    const r = await p.place(plan("deep"));
    expect(!r.ok && r.error.reason).toBe("depth");
    expect(store.list()).toHaveLength(0);
    expect((await make({ depth: 1, maxDepth: 2 }).p.place(plan("ok"))).ok).toBe(true);
  });

  test("refuses a duplicate name; retire is idempotent", async () => {
    const { p } = make();
    await p.place(plan("a"));
    const r = await p.place(plan("a"));
    expect(!r.ok && r.error.reason).toBe("exists");
    expect((await p.retire("nope")).ok).toBe(true);
  });
});
