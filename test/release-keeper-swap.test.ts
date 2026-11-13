/**
 * The keeper ships by swapping, not by image (#8042). On a hosted child
 * forge's shape: a running tree, a landed tree, a keeper that cuts on cadence,
 * swaps it in beside the running process on the same port, verifies it under
 * load and keeps it as known good; then a bad release is swapped in, fails
 * its verify, and the known-good tree is swapped back and held. The stand-in
 * forges are a few lines that answer health as the commit and version they
 * are told; the swap, the pin, the keep and the keeper are the real code.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok } from "../src/kernel/result.ts";
import { standingHolds } from "../src/keeper/hold.ts";
import { landedToLive, newestLive, secondsWords } from "../src/keeper/landed.ts";
import { tick } from "../src/keeper/keeper.ts";
import { listKeeperReleases } from "../src/keeper/record.ts";
import { keeperEnv, SWAP_INTERVAL_MS, switched } from "../src/keeper/wire.ts";
import { keeperAnswer } from "../src/keeper/landed.ts";
import { keeperPanel } from "../src/web/pages/keeper-panel.ts";
import { swapper, dependencyChange } from "../src/keeper/swapper.ts";
import { keepGood, lastGood } from "../src/release/launch.ts";
import { releaseDir } from "../src/release/checkout.ts";
import { liveSchema } from "../src/release/rollback.ts";
import { readServing } from "../src/release/serving.ts";
import { endSwap, handover } from "../src/release/swap.ts";
import { keeperForge, A, B, C } from "./helpers/keeper.ts";

const STAND_IN = `
Bun.serve({
  port: Number(process.env.PORT),
  reusePort: true,
  fetch: () => Response.json({ ok: true, draining: false, commit: process.env.FORGE_COMMIT, version: process.env.FORGE_VERSION }),
});
`;
const realMigrate = (() => {
  try {
    return readFileSync("/proc/sys/net/ipv4/tcp_migrate_req", "utf8").trim() === "1";
  } catch {
    return false;
  }
})();
handover.migrate = true;

const dirs: string[] = [];
const pids = new Set<number>();
afterAll(() => {
  // The swap turn and the kernel switch are this process's: leave them as other files find them.
  endSwap(false);
  delete handover.migrate;
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** `migrations` is how many the tree knows: more than any live database, unless a test says fewer. */
function tree(root: string, main = STAND_IN, pkg = "{}", migrations = 9999): void {
  mkdirSync(join(root, "src", "core"), { recursive: true });
  writeFileSync(join(root, "src", "core", "schema.ts"), `export const migrations = new Array(${migrations}).fill(0);\n`);
  writeFileSync(join(root, "src", "main.ts"), main);
  writeFileSync(join(root, "package.json"), pkg);
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port ?? 0;
  s.stop(true);
  return port;
}

async function health(port: number): Promise<{ commit?: string; version?: string } | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { headers: { connection: "close" }, signal: AbortSignal.timeout(3_000) });
    return (await res.json()) as { commit?: string; version?: string };
  } catch {
    return undefined;
  }
}

/** A forge running tree A on a port, with a swapper that checks landed trees out of `landed`. */
async function hosted(landed: Record<string, { main?: string; pkg?: string; preflight?: boolean }>) {
  const f = await keeperForge();
  const base = mkdtempSync(join(tmpdir(), "forge-keeper-swap-"));
  dirs.push(base);
  const dataDir = f.app.config.dataDir;
  const running = join(base, "running");
  tree(running);
  const port = await freePort();
  const old = Bun.serve({ port, reusePort: true, fetch: () => Response.json({ ok: true, draining: false, commit: A, version: "0.7.283" }) });
  const now = { commit: A as string, version: "0.7.283" };
  let before: number | undefined = undefined;
  const drained: string[] = [];
  /**
   * The swapper's clock: still, except that checking out a tree that has served (a rollback)
   * takes 40 s.
   */
  const clock = { t: 1_700_000_000_000 };
  const build = () => swapper({
    dataDir,
    port,
    treeRoot: running,
    version: () => now.version,
    commit: () => now.commit,
    env: { PATH: process.env.PATH, FORGE_VERSION: "0.7.283", FORGE_BASE_VERSION: "0.7.283" },
    checkout: async (sha) => {
      const spec = landed[sha];
      if (spec === undefined) return err("no such commit");
      const dir = releaseDir(dataDir, sha);
      if (existsSync(join(dir, ".was-live"))) clock.t += 40_000;
      if (!existsSync(dir)) tree(dir, spec.main, spec.pkg);
      return ok(dir);
    },
    preflight: async (dir) => {
      const sha = dir.split("/").pop()!;
      return landed[sha]?.preflight === false ? { ok: false, line: "boot failed: (fixture)" } : { ok: true, line: "preflight ok" };
    },
    now: () => clock.t,
    timed: switched(f.app.db, () => 0),
    drain: () => {
      drained.push(now.commit);
      // The process that handed over lets go of the port; the one before it, started by a swap, is stopped.
      if (before === undefined) old.stop(true);
      else
        try {
          process.kill(before, "SIGTERM");
        } catch {}
      before = readServing(dataDir)?.pid;
      if (before !== undefined) pids.add(before);
    },
  });
  const h = {
    f,
    ports: { ...f.ports, deployer: build(), minIntervalMs: SWAP_INTERVAL_MS } as typeof f.ports,
    dataDir,
    port,
    now,
    drained,
    running,
    /** The swapped-in process is a new process: its own swapper, its own turn at the swap. */
    become(commit: string, version: string) {
      now.commit = commit;
      now.version = version;
      endSwap(false);
      h.ports = { ...h.ports, deployer: build() };
    },
  };
  return h;
}

describe("the keeper swaps main's tree in; a pod restart comes back on it", () => {
  test("land, swap, verify, bad release, swap back: no refused request, known good kept, held", async () => {
    const h = await hosted({ [B]: {}, [C]: {} });
    const { f } = h;
    // A client that hits the port for the whole story.
    let stop = false;
    const seen = { ok: 0, bad: 0 };
    const hammer = (async () => {
      while (!stop) {
        const got = await health(h.port);
        if (got?.commit === undefined) seen.bad++;
        else seen.ok++;
        await Bun.sleep(5);
      }
    })();

    // Land: main moves to B (a landing the forge already checked out and recorded).
    f.land(7, "A change");
    f.app.db.query(`INSERT INTO release (sha, repo_id, pull_number, ok, line, created_at) VALUES (?1, ?2, 7, 1, 'preflight ok', ?3)`).run(B, f.repo.id, new Date(f.world.now).toISOString());
    f.world.now += 61_000; // the cadence minute
    const cut = await tick(h.ports);
    expect(cut).toContain("cut 0.7.284");
    expect(cut).toContain(`promoted to tree/${B}:0.7.284`);
    // The new process answers on the same port as its own commit and version, beside the draining one.
    expect(await (async () => { for (let i = 0; i < 40; i++) { const g = await health(h.port); if (g?.commit === B) return g; await Bun.sleep(50); } })()).toMatchObject({ commit: B, version: "0.7.284" });
    expect(h.drained).toEqual([A]);
    expect(readServing(h.dataDir)?.sha).toBe(B);
    // The tree it left is pinned where a rollback finds it, marked as having served.
    expect(existsSync(join(releaseDir(h.dataDir, A), "src", "main.ts"))).toBe(true);
    expect(existsSync(join(releaseDir(h.dataDir, A), ".was-live"))).toBe(true);

    // Verify: the new process is the keeper now.
    h.become(B, "0.7.284");
    f.world.live = "0.7.284";
    f.world.now += 5_000;
    expect(await tick(h.ports)).toContain("0.7.284 verified live");
    expect(lastGood(h.dataDir)).toMatchObject({ version: "0.7.284", commit: B, base: "0.7.283" });
    expect(existsSync(join(h.dataDir, "release", "good", "0.7.284", "src", "main.ts"))).toBe(true);
    const [first] = listKeeperReleases(f.app.db);
    expect(first).toMatchObject({ stage: "verified", knownGood: { version: "0.7.283", image: `tree/${A}:0.7.283` } });
    // Landed to live: from the merge to the new version answering, the page's number.
    // Merged, 61 s to the cadence's minute, 5 s for the new process to answer.
    expect(landedToLive(f.app.db, first!)).toBe(66);
    expect(newestLive(f.app.db)).toMatchObject({ version: "0.7.284", sha: B });

    // A bad release: C boots and answers, then fails under load.
    f.world.main = C;
    f.world.now += 61_000;
    expect(await tick(h.ports)).toContain(`promoted to tree/${C}:0.7.285`);
    h.become(C, "0.7.285");
    f.world.live = "0.7.285";
    f.world.healthz = (n) => (n >= 6 ? { status: 503, ms: 4 } : { status: 200, ms: 4 });
    const verdict = await tick(h.ports);
    expect(verdict).toContain("0.7.285 failed its verify");
    expect(verdict).toContain(`rolled back to 0.7.284 (tree/${B}:0.7.284)`);
    // Swapped back: the pinned B tree serves again as 0.7.284.
    const back = await (async () => { for (let i = 0; i < 60; i++) { const g = await health(h.port); if (g?.commit === B && g.version === "0.7.284") return g; await Bun.sleep(50); } })();
    expect(back).toMatchObject({ commit: B, version: "0.7.284" });
    expect(standingHolds(f.app.db)[0]).toMatchObject({ kind: "failed", version: "0.7.285" });
    // The rollback is timed (#11919): the clock moved 40 s between the swap asked and the
    // known-good tree serving.
    const rolled = listKeeperReleases(f.app.db)[0]!;
    expect(rolled).toMatchObject({ version: "0.7.285", stage: "rolled_back", rollbackMs: 40_000 });
    expect(listKeeperReleases(f.app.db)[1]!.rollbackMs).toBeNull();
    expect(keeperAnswer(f.app.db).releases[0]!.stages.rollbackMs).toBe(40_000);
    expect(String(keeperPanel(f.app.db))).toContain("rolled back in 40 s");
    // What a restart would run is still the verified B, not the bad C and not the image.
    expect(lastGood(h.dataDir)).toMatchObject({ version: "0.7.284", commit: B, base: "0.7.283" });

    stop = true;
    await hammer;
    expect(seen.ok).toBeGreaterThan(10);
    // The promise of 0 refused requests holds where the kernel migrates queued connections (the check runs there).
    if (realMigrate) expect(seen.bad).toBe(0);
  }, 60_000);

  test("a tree that adds a dependency is not cut: no tag, no row, and the line asks for a new image", async () => {
    const h = await hosted({ [B]: { pkg: JSON.stringify({ dependencies: { left: "1.0.0" } }) } });
    h.f.world.now += 61_000;
    const line = await tick(h.ports);
    expect(line).toContain("not cut: dependencies names left");
    expect(line).toContain("needs a new image");
    expect(h.f.world.tags).toHaveLength(0);
    expect(listKeeperReleases(h.f.app.db)).toHaveLength(0);
    expect(h.drained).toEqual([]);
    expect(dependencyChange(join(h.running))).toBeUndefined();
  });

  test("a process that cannot swap (it holds the SSH terminal) cuts nothing", async () => {
    const h = await hosted({ [B]: {} });
    h.f.world.now += 61_000;
    handover.ssh = true;
    try {
      expect(await tick(h.ports)).toContain("not cut: this process holds the SSH terminal");
    } finally {
      delete handover.ssh;
    }
    expect(h.f.world.tags).toHaveLength(0);
  });

  test("a tree whose preflight is red is not cut", async () => {
    const h = await hosted({ [B]: { preflight: false } });
    h.f.world.now += 61_000;
    expect(await tick(h.ports)).toContain("not cut: preflight failed: boot failed");
    expect(h.f.world.tags).toHaveLength(0);
  });

  test("a release that will not come up leaves the running process serving and the cut sent again", async () => {
    const h = await hosted({ [B]: { main: `await Bun.sleep(60000)` } });
    h.f.world.now += 61_000;
    const line = await tick({ ...h.ports, deployer: swapper({ ...swapOf(h), budgetMs: 800 }) });
    expect(line).toContain("refused");
    expect((await health(h.port))?.commit).toBe(A);
    expect(h.drained).toEqual([]);
  }, 20_000);

  test("a refusal is remembered per commit: two ticks check out and preflight once", async () => {
    const h = await hosted({ [B]: {} });
    h.f.world.now += 61_000;
    let checkouts = 0;
    let preflights = 0;
    const base = swapOf(h);
    const deployer = swapper({
      ...base,
      checkout: async (sha: string) => {
        checkouts++;
        tree(releaseDir(h.dataDir, sha));
        return ok(releaseDir(h.dataDir, sha));
      },
      preflight: async () => {
        preflights++;
        return { ok: false, line: "boot failed: (fixture)" };
      },
    });
    const ports = { ...h.ports, deployer };
    expect(await tick(ports)).toContain("not cut: preflight failed");
    h.f.world.now += 61_000;
    expect(await tick(ports)).toContain("not cut: preflight failed");
    expect(preflights).toBe(1);
    expect(checkouts).toBe(1);
  });

  test("a swap back to a tree that knows fewer migrations than the database is refused, and says why", async () => {
    const h = await hosted({});
    const live = liveSchema(h.dataDir);
    expect(live).toBeGreaterThan(1);
    // B has served (pinned and marked) but predates the live schema; C is as new.
    tree(releaseDir(h.dataDir, B), STAND_IN, "{}", live - 1);
    writeFileSync(join(releaseDir(h.dataDir, B), ".was-live"), "");
    // C never answers: one that did would win the swap on a fast machine and be left on the port.
    tree(releaseDir(h.dataDir, C), `await Bun.sleep(60000)`, "{}", live);
    writeFileSync(join(releaseDir(h.dataDir, C), ".was-live"), "");
    endSwap(false);
    const deployer = swapper({ ...swapOf(h), checkout: async (sha: string) => ok(releaseDir(h.dataDir, sha)), budgetMs: 800 });
    await expect(deployer.setImage(`tree/${B}:0.7.284`)).rejects.toThrow(`${B} predates schema ${live}; rolling back would need a down-migration`);
    expect(h.drained).toEqual([]);
    expect((await health(h.port))?.commit).toBe(A);
    // A tree with the live schema is not refused by the guard (this one then fails to answer in its short budget, a different line).
    await expect(deployer.setImage(`tree/${C}:0.7.285`)).rejects.not.toThrow("predates schema");
  }, 20_000);

  test("the running commit must be stamped to name a known good", async () => {
    const h = await hosted({ [B]: {} });
    h.now.commit = "";
    await expect(h.ports.deployer.image()).rejects.toThrow("not stamped");
  });
});

/** The pieces `hosted` built the swapper from, for a variant of it. */
function swapOf(h: Awaited<ReturnType<typeof hosted>>) {
  return {
    dataDir: h.dataDir,
    port: h.port,
    treeRoot: h.running,
    version: () => h.now.version,
    commit: () => h.now.commit,
    env: { PATH: process.env.PATH },
    checkout: async (sha: string) => {
      tree(releaseDir(h.dataDir, sha), `await Bun.sleep(60000)`);
      return ok(releaseDir(h.dataDir, sha));
    },
    preflight: async () => ({ ok: true, line: "ok" }),
    drain: () => h.drained.push("x"),
  };
}

test("swap mode needs no cluster, only the swap switch", () => {
  expect(keeperEnv({ FORGE_RELEASE_KEEPER: "swap", FORGE_SELF_SWAP: "1" })).toEqual({ on: true, mode: "swap" });
  expect(keeperEnv({ FORGE_RELEASE_KEEPER: "swap" })).toMatchObject({ on: false });
  expect(keeperEnv({ FORGE_RELEASE_KEEPER: "on", KUBERNETES_SERVICE_HOST: "10.0.0.1" })).toMatchObject({ on: true, mode: "kube" });
  expect(SWAP_INTERVAL_MS).toBe(60_000);
});

test("seconds are said in words", () => {
  expect(secondsWords(45)).toBe("45 s");
  expect(secondsWords(72)).toBe("1 min 12 s");
});

test("keeping a swapped tree names the image it is over", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-keep-"));
  dirs.push(dir);
  const t = join(dir, "t");
  tree(t);
  keepGood(dir, t, "0.7.290", B, 1, "0.7.283");
  expect(lastGood(dir)?.base).toBe("0.7.283");
});
