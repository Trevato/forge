/**
 * The release step prunes its own old releases (#11801): the rule is plain
 * data in and a list out, the keeper runs it once a release is verified live
 * and puts the list on `release.verified_live`, and the swapper's store is the
 * trees under `releases/<sha>/`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "../src/kernel/result.ts";
import { tagOf, type ReleaseStore } from "../src/keeper/deploy.ts";
import { tick } from "../src/keeper/keeper.ts";
import { KEEP_NEWEST, toPrune, type Stored } from "../src/keeper/prune.ts";
import { swapper } from "../src/keeper/swapper.ts";
import { releaseDir } from "../src/release/checkout.ts";
import { keeperForge } from "./helpers/keeper.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** `n` releases, `r1` oldest, one minute apart. */
const releases = (n: number): Stored[] => Array.from({ length: n }, (_, i) => ({ id: `r${i + 1}`, at: 60_000 * (i + 1) }));

describe("the rule", () => {
  test("20 releases keep the newest 15 plus the live one and the known-good", () => {
    const gone = toPrune(releases(20), ["r20", "r19"]);
    expect(KEEP_NEWEST).toBe(15);
    expect(gone).toEqual(["r1", "r2", "r3", "r4", "r5"]);
  });

  test("a known-good older than the newest 15 is kept, and so is a live one", () => {
    expect(toPrune(releases(20), ["r20", "r2"])).toEqual(["r1", "r3", "r4", "r5"]);
    expect(toPrune(releases(20), ["r3", "r2"])).toEqual(["r1", "r4", "r5"]);
  });

  test("15 or fewer prune nothing; order in, ties and repeats do not change the answer", () => {
    expect(toPrune(releases(15), [])).toEqual([]);
    expect(toPrune([], ["r1"])).toEqual([]);
    const shuffled = [...releases(20)].reverse();
    expect(toPrune(shuffled, ["r20"])).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    // A repeated id counts once, at its newest.
    expect(toPrune([...releases(16), { id: "r1", at: 999_999_999 }], [])).toEqual(["r2"]);
  });

  test("a nonsense limit keeps at least one", () => {
    expect(toPrune(releases(3), [], 0)).toEqual(["r1", "r2"]);
    expect(toPrune(releases(17), [], Number.NaN)).toEqual(["r1", "r2"]);
  });
});

/** A registry of tags, as the fake Deployment's images name them. */
function fakeStore(tags: Stored[]) {
  const held = new Map(tags.map((t) => [t.id, t.at]));
  const store: ReleaseStore = {
    list: async () => [...held].map(([id, at]) => ({ id, at })),
    idOf: (ref) => tagOf(ref) || undefined,
    async remove(id) {
      held.delete(id);
    },
  };
  return { store, held };
}

describe("the keeper prunes after verified live", () => {
  async function verifiedWith(tags: Stored[], store?: (s: ReleaseStore) => ReleaseStore) {
    const f = await keeperForge();
    const fake = fakeStore(tags);
    Object.assign(f.ports.deployer, { store: store === undefined ? fake.store : store(fake.store) });
    await tick(f.ports); // cut 0.7.284, known good 0.7.283
    f.world.live = "0.7.284";
    const line = await tick(f.ports);
    expect(line).toContain("0.7.284 verified live");
    return { f, held: fake.held, event: f.events("release.verified_live")[0]! };
  }

  // 0.7.265 … 0.7.284, one minute apart: the live one newest, its known good 0.7.283 next.
  const twenty = Array.from({ length: 20 }, (_, i) => ({ id: `0.7.${265 + i}`, at: 60_000 * (i + 1) }));

  test("of 20 releases the 5 oldest go, and the event names them", async () => {
    const { held, event } = await verifiedWith(twenty);
    expect(event["pruned"]).toEqual(["0.7.265", "0.7.266", "0.7.267", "0.7.268", "0.7.269"]);
    expect(event["pruneError"]).toBeUndefined();
    expect(held.size).toBe(15);
    expect(held.has("0.7.284")).toBe(true);
    expect(held.has("0.7.283")).toBe(true);
  });

  test("a known-good older than the newest 15 stays", async () => {
    // 0.7.283 was stored first; twenty newer ones were stored since.
    const tags = [{ id: "0.7.283", at: 1 }, ...Array.from({ length: 20 }, (_, i) => ({ id: `0.7.${300 + i}`, at: 60_000 * (i + 1) })), { id: "0.7.284", at: 9e9 }];
    const { held, event } = await verifiedWith(tags);
    expect(event["pruned"]).toEqual(["0.7.300", "0.7.301", "0.7.302", "0.7.303", "0.7.304", "0.7.305"]);
    expect(held.has("0.7.283")).toBe(true);
    expect(held.has("0.7.284")).toBe(true);
    expect(held.size).toBe(16);
  });

  test("a store that fails says why on the event, keeps what it did, and the release stays verified", async () => {
    const { f, event } = await verifiedWith(twenty, (s) => ({
      ...s,
      async remove(id) {
        if (id === "0.7.266") throw new Error("registry said 503");
        await s.remove(id);
      },
    }));
    expect(event["pruned"]).toEqual(["0.7.265"]);
    expect(event["pruneError"]).toBe("registry said 503");
    expect(f.app.db.query<{ stage: string }, []>("SELECT stage FROM keeper_release").get()!.stage).toBe("verified");
  });

  test("a known-good the store cannot name prunes nothing and says why", async () => {
    const { held, event } = await verifiedWith(twenty, (s) => ({ ...s, idOf: (ref) => (ref.endsWith(":0.7.283") ? undefined : s.idOf(ref)) }));
    expect(event["pruned"]).toEqual([]);
    expect(String(event["pruneError"])).toContain("names no stored release");
    expect(held.size).toBe(20);
  });

  test("a running image the store cannot name prunes nothing", async () => {
    const f = await keeperForge();
    const fake = fakeStore(twenty);
    Object.assign(f.ports.deployer, { store: { ...fake.store, idOf: (ref: string) => (ref.startsWith("other/") ? undefined : fake.store.idOf(ref)) } });
    await tick(f.ports);
    f.world.live = "0.7.284";
    Object.assign(f.ports.deployer, { image: async () => "other/forge@sha256:abc" });
    await tick(f.ports);
    const event = f.events("release.verified_live")[0]!;
    expect(event["pruned"]).toEqual([]);
    expect(String(event["pruneError"])).toContain("other/forge@sha256:abc");
    expect(fake.held.size).toBe(20);
  });

  test("a deployer without a store prunes nothing", async () => {
    const f = await keeperForge();
    await tick(f.ports);
    f.world.live = "0.7.284";
    await tick(f.ports);
    expect(f.events("release.verified_live")[0]!["pruned"]).toEqual([]);
  });
});

describe("the swapper's store", () => {
  const sha = (n: number) => n.toString(16).padStart(40, "0");

  function swapStore(running: string) {
    const dataDir = mkdtempSync(join(tmpdir(), "forge-prune-"));
    dirs.push(dataDir);
    const deployer = swapper({
      dataDir,
      port: 0,
      treeRoot: dataDir,
      version: () => "0.7.1",
      commit: () => running,
      env: {},
      checkout: async (s) => ok(releaseDir(dataDir, s)),
      preflight: async () => ({ ok: true, line: "" }),
      drain: () => {},
    });
    return { dataDir, store: deployer.store! };
  }

  test("lists the trees under releases/ by when each was touched, and nothing else", async () => {
    const { dataDir, store } = swapStore(sha(99));
    for (let n = 1; n <= 3; n++) {
      mkdirSync(releaseDir(dataDir, sha(n)), { recursive: true });
      utimesSync(releaseDir(dataDir, sha(n)), n, n);
    }
    mkdirSync(join(dataDir, "releases", "good", "0.7.1"), { recursive: true });
    mkdirSync(join(dataDir, "releases", `.${sha(4)}.partial`), { recursive: true });
    const found = (await store.list()).sort((a, b) => a.at - b.at);
    expect(found).toEqual([1, 2, 3].map((n) => ({ id: sha(n), at: n * 1000 })));
    expect(store.idOf(`tree/${sha(2)}:0.7.2`)).toBe(sha(2));
    expect(store.idOf("reg.test/o/forge:0.7.2")).toBeUndefined();
  });

  test("removes a tree by commit, never the running one or a path", async () => {
    const { dataDir, store } = swapStore(sha(1));
    for (const n of [1, 2]) mkdirSync(releaseDir(dataDir, sha(n)), { recursive: true });
    await store.remove(sha(2));
    expect(existsSync(releaseDir(dataDir, sha(2)))).toBe(false);
    await expect(store.remove(sha(1))).rejects.toThrow("is running");
    await expect(store.remove("../good")).rejects.toThrow("not a commit id");
    expect(existsSync(releaseDir(dataDir, sha(1)))).toBe(true);
  });

  test("an empty data directory lists nothing", async () => {
    expect(await swapStore(sha(1)).store.list()).toEqual([]);
  });
});
