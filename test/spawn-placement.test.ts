import { describe, expect, test } from "bun:test";
import { childPublicUrl, childHostSuffix, hostedPlacement, memoryBodies, parseHostedChildName } from "../src/spawn/placement.ts";
import type { SpawnPlan } from "../src/spawn/plan.ts";

const plan = (name: string): SpawnPlan => ({ name, org: "o", apps: [], briefs: [], subscriptions: [], direction: "", keepAccess: false, budgetUsd: null });
const make = (o: Partial<Parameters<typeof hostedPlacement>[0]> = {}) => {
  let n = 0;
  const store = memoryBodies();
  return { store, p: hostedPlacement({ host: "f.test", store, newId: () => `b${++n}`, ...o }) };
};

describe("hosted placement", () => {
  test("places a child as a subdomain of the parent, one agent, no SSH", async () => {
    const { p, store } = make();
    const r = await p.place(plan("kid"));
    expect(r).toEqual({ ok: true, value: { url: "https://kid--f.test", bodyId: "b1" } });
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

describe("hosted child hostnames", () => {
  test("derive a single-label child URL from the parent host", () => {
    expect(childHostSuffix("forge.open-platform.sh")).toBe("--forge.open-platform.sh");
    expect(childPublicUrl("homie", "forge.open-platform.sh")).toBe(
      "https://homie--forge.open-platform.sh",
    );
    expect(childPublicUrl("kid", "forge.test")).toBe("https://kid--forge.test");
  });

  test("parse a child name from Host", () => {
    expect(parseHostedChildName("homie--forge.open-platform.sh", "forge.open-platform.sh")).toBe("homie");
    expect(parseHostedChildName("forge.open-platform.sh", "forge.open-platform.sh")).toBeUndefined();
    expect(parseHostedChildName("notes--forge-trevato-apps.open-platform.sh", "forge.open-platform.sh")).toBeUndefined();
    expect(parseHostedChildName("Homie--Forge.open-platform.sh:443", "forge.open-platform.sh")).toBe("homie");
  });
});

describe("a hosted child's app label", () => {
  test("is bounded by one DNS label, not by the child's name", async () => {
    const { parseHostedChildAppLabel, parseHostedChildName } = await import("../src/spawn/placement.ts");
    const label = `${"a".repeat(20)}--${"b".repeat(20)}`;
    expect(parseHostedChildName(`${label}--forge.test`, "forge.test")).toBeUndefined();
    expect(parseHostedChildAppLabel(`${label}--forge.test`, "forge.test")).toBe(label);
    expect(parseHostedChildAppLabel(`${"a".repeat(64)}--forge.test`, "forge.test")).toBeUndefined();
  });
});
