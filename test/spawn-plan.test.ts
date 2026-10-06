import { describe, expect, test } from "bun:test";
import { dryRun, planSpawn, type SpawnSource } from "../src/spawn/plan.ts";

const secrets = ["sk-live-SECRET", "ssh-rsa PRIVATEKEY", "ghp_TOKEN", "hunter2"];

const source = {
  catalog: [
    { ref: "a/notes", readable: true, bytes: 1000, forgeJsonBytes: 40, token: secrets[2], env: { KEY: secrets[0] } },
    { ref: "a/blog", readable: true, bytes: 500, forgeJsonBytes: 40, sshKey: secrets[1] },
    { ref: "b/private", readable: false, bytes: 9, forgeJsonBytes: 1 },
  ],
  briefs: [{ agent: "scout", text: "ship small", credential: secrets[3] }],
  subscriptions: ["feed:z", "feed:a", "feed:a"],
} as unknown as SpawnSource;

const base = { name: "kid", org: "kids", apps: ["a/notes", "a/blog"], carryBriefs: true, carrySubscriptions: true };

describe("planSpawn", () => {
  test("plans apps, briefs and subscription names, sorted", () => {
    const r = planSpawn(base, source);
    if (!r.ok) throw new Error(r.error.reason);
    expect(r.value.apps.map((a) => a.ref)).toEqual(["a/blog", "a/notes"]);
    expect(r.value.subscriptions).toEqual(["feed:a", "feed:z"]);
    expect(r.value.briefs).toEqual([{ agent: "scout", text: "ship small" }]);
  });

  test("a forge full of secrets yields a plan with none of them", () => {
    const r = planSpawn(base, source);
    if (!r.ok) throw new Error();
    const text = JSON.stringify(r.value) + JSON.stringify(dryRun(r.value, source));
    for (const s of secrets) expect(text).not.toContain(s);
  });

  test("deterministic", () => {
    const flipped = { ...base, apps: [...base.apps].reverse() };
    expect(JSON.stringify(planSpawn(base, source))).toBe(JSON.stringify(planSpawn(flipped, source)));
  });

  test("opt-outs carry nothing", () => {
    const r = planSpawn({ ...base, carryBriefs: false, carrySubscriptions: false }, source);
    if (!r.ok) throw new Error();
    expect(r.value.briefs).toEqual([]);
    expect(r.value.subscriptions).toEqual([]);
  });

  test("refuses bad names, lists and references with the reason", () => {
    const bad = (patch: object) => planSpawn({ ...base, ...patch }, source);
    expect(bad({ name: "Bad Name" })).toMatchObject({ ok: false, error: { field: "name" } });
    expect(bad({ org: 5 })).toMatchObject({ ok: false, error: { field: "org" } });
    expect(bad({ apps: "a/notes" })).toMatchObject({ ok: false, error: { field: "apps" } });
    expect(bad({ apps: ["../etc"] })).toMatchObject({ ok: false });
    expect(bad({ apps: ["a/nope"] })).toMatchObject({ ok: false, error: { reason: "a/nope is not a known app" } });
    expect(bad({ apps: ["b/private"] })).toMatchObject({ ok: false, error: { reason: "b/private is not readable by you" } });
    expect(bad({ apps: ["a/notes", "a/notes"] })).toMatchObject({ ok: false });
    expect(bad({ apps: Array(51).fill("a/notes") })).toMatchObject({ ok: false });
    expect(bad({ carryBriefs: "yes" })).toMatchObject({ ok: false, error: { field: "carryBriefs" } });
  });

  test("dry run lists copied, left behind and bytes", () => {
    const r = planSpawn(base, source);
    if (!r.ok) throw new Error();
    const d = dryRun(r.value, source);
    expect(d.copied).toContain("app a/notes (full history, forge.json)");
    expect(d.leftBehind).toContain("secrets");
    expect(d.leftBehind).toContain("run ledger");
    expect(d.bytes).toBe(1500 + 10 + 12);
  });
});
