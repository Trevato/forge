/**
 * A green release takes over the listening port (#1663): the new process
 * starts beside the old on SO_REUSEPORT, is read healthy as its own commit,
 * and only then does the old one drain; an unhealthy one is stopped and the
 * old keeps serving. The stand-in forge is a few lines that answer the
 * health route as the commit they are told.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { openPull } from "../src/actions/pulls.ts";
import { releaseOnLand } from "../src/checks/landing.ts";
import { listComments } from "../src/core/issues.ts";
import { createUser } from "../src/core/users.ts";
import { beginSwap, endSwap, healthyAs, handover, migratesQueuedConnections, startRelease } from "../src/release/swap.ts";
import { releaseEnv } from "../src/release/env.ts";

const OLD = "0".repeat(40);
const NEW = "1".repeat(40);
const BAD = "2".repeat(40);

const STAND_IN = `
if (process.argv.includes("--preflight")) { console.log("preflight ok: stand-in"); process.exit(0); }
Bun.serve({
  port: Number(process.env.PORT),
  reusePort: true,
  fetch: () => Response.json({ ok: true, draining: false, commit: process.env.FORGE_COMMIT }),
});
`;
// Boots and listens, but answers unwell.
const SICK = STAND_IN.replace("ok: true", "ok: false");
// Never listens at all.
const DEAD = `if (process.argv.includes("--preflight")) process.exit(0);\nawait Bun.sleep(60000);\n`;

const dirs: string[] = [];
const pids: number[] = [];
afterAll(async () => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function tree(main: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "forge-swap-"));
  dirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "main.ts"), main);
  return dir;
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port ?? 0;
  s.stop(true);
  return port;
}

const commitAt = async (port: number): Promise<string | undefined> => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: { connection: "close" },
      signal: AbortSignal.timeout(3_000),
    });
    return ((await res.json()) as { commit?: string }).commit;
  } catch {
    return undefined;
  }
};

function oldForge(port: number) {
  return Bun.serve({
    port,
    reusePort: true,
    fetch: () => Response.json({ ok: true, draining: false, commit: OLD }),
  });
}

describe("what counts as healthy", () => {
  test("well, not leaving, and the commit that was started", () => {
    expect(healthyAs({ ok: true, draining: false, commit: NEW }, NEW)).toBe(true);
    expect(healthyAs({ ok: true, draining: false, commit: OLD }, NEW)).toBe(false);
    expect(healthyAs({ ok: false, commit: NEW }, NEW)).toBe(false);
    expect(healthyAs({ ok: true, draining: true, commit: NEW }, NEW)).toBe(false);
    expect(healthyAs(null, NEW)).toBe(false);
    expect(healthyAs("ok", NEW)).toBe(false);
  });

  test("the swap switch is exactly FORGE_SELF_SWAP=1", () => {
    expect(releaseEnv({ FORGE_SELF_SWAP: "1" }).selfSwap).toBe(true);
    expect(releaseEnv({ FORGE_SELF_SWAP: "true" }).selfSwap).toBeUndefined();
    expect(releaseEnv({}).selfSwap).toBeUndefined();
    expect(releaseEnv({ FORGE_SWAP_BUDGET_S: "30" }).swapBudgetMs).toBe(30_000);
    expect(releaseEnv({ FORGE_SWAP_BUDGET_S: "0" }).swapBudgetMs).toBeUndefined();
  });
});

// The zero-failure promise holds only where the kernel migrates queued connections.
const realMigrate = (() => {
  try {
    return readFileSync("/proc/sys/net/ipv4/tcp_migrate_req", "utf8").trim() === "1";
  } catch {
    return false;
  }
})();
const whenMigrating = realMigrate ? test : test.skip;
// Everything else here exercises the flow, not the kernel: pretend it is on.
handover.migrate = true;

describe("swapping on the listening port", () => {
  test("the swap is refused unless the kernel migrates queued connections", async () => {
    handover.migrate = false;
    try {
      const turn = beginSwap();
      expect(turn.ok).toBe(false);
      if (!turn.ok) {
        expect(turn.line).toContain("tcp_migrate_req=1");
        expect(turn.tell).toBe(true);
      }
      handover.migrate = true;
      expect(beginSwap().ok).toBe(true);
      endSwap(false);
    } finally {
      handover.migrate = true;
    }
    expect(migratesQueuedConnections()).toBe(true);
  });

  whenMigrating("a client looping through the swap sees no failure, then only the new sha", async () => {
    const port = await freePort();
    const old = oldForge(port);
    const dir = await tree(STAND_IN);
    let stop = false;
    let failed = 0;
    let total = 0;
    const seen = new Set<string>();
    const client = (async () => {
      while (!stop) {
        total++;
        const c = await commitAt(port);
        if (c === undefined) failed++;
        else seen.add(c);
        await Bun.sleep(2);
      }
    })();
    const out = await startRelease({ dir, sha: NEW, port, env: process.env, budgetMs: 20_000 });
    expect(out.ok).toBe(true);
    if (out.ok) pids.push(out.pid);
    // The old drains: it stops taking connections, finishing what it holds.
    old.stop();
    await Bun.sleep(300);
    const afterOld = total;
    await Bun.sleep(300);
    stop = true;
    await client;
    expect(failed).toBe(0);
    expect(total).toBeGreaterThan(afterOld);
    expect(seen.has(NEW)).toBe(true);
    expect(await commitAt(port)).toBe(NEW);
  }, 40_000);

  test("a process that listens but is unwell is stopped, and the old sha keeps serving", async () => {
    const port = await freePort();
    const old = oldForge(port);
    const dir = await tree(SICK);
    const out = await startRelease({ dir, sha: BAD, port, env: process.env, budgetMs: 1_500 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.line).toContain("not healthy within");
    for (let i = 0; i < 20; i++) expect(await commitAt(port)).toBe(OLD);
    old.stop(true);
  }, 20_000);

  test("a process that dies on boot is reported as that, at once", async () => {
    const port = await freePort();
    const old = oldForge(port);
    const dir = await tree("process.exit(3);\n");
    const t = Date.now();
    const out = await startRelease({ dir, sha: BAD, port, env: process.env, budgetMs: 20_000 });
    expect(out).toEqual({ ok: false, line: "the new process exited with 3 before it was healthy" });
    expect(Date.now() - t).toBeLessThan(5_000);
    expect(await commitAt(port)).toBe(OLD);
    old.stop(true);
  }, 30_000);
});

describe("on landing", () => {
  async function setup(selfSwap: boolean, port: number, main: string) {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-swap-land-"));
    dirs.push(dataDir);
    const app = createApp({ dataDir, port, forgeRepo: "alice/forge-code", selfSwap, swapBudgetMs: 5_000 });
    const u = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "a@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error("user");
    const r = await createRepo(app, u.value, { name: "forge-code", visibility: "public" });
    if (!r.ok) throw new Error("repo");
    await commitToBranch(app, u.value, r.value, { message: "seed", files: [{ path: "a.txt", content: "a" }] });
    await commitToBranch(app, u.value, r.value, { message: "b", branch: "change", files: [{ path: "b.txt", content: "b" }] });
    const opened = await openPull(app, u.value, r.value, {
      title: "t",
      baseBranch: r.value.defaultBranch,
      headBranch: "change",
    });
    if (!opened.ok) throw new Error("pull");
    const made = await commitToBranch(app, u.value, r.value, {
      message: "land",
      files: [{ path: "src/main.ts", content: main }],
    });
    if (!made.ok) throw new Error("commit");
    return { app, user: u.value, repo: r.value, pull: opened.value, sha: made.value.commitOid };
  }

  test("a release that never comes up leaves the old process and tells the pull", async () => {
    const port = await freePort();
    const old = oldForge(port);
    let drained = 0;
    handover.drain = () => {
      drained++;
    };
    try {
      // Dead after a green preflight: the swap fails, nothing drains.
      const bad = await setup(true, port, DEAD);
      const sha = bad.sha;
      const run = releaseOnLand(bad.app, bad.user, bad.repo, bad.pull, sha);
      const release = await run;
      expect(release?.ok).toBe(true);
      expect(drained).toBe(0);
      const told = listComments(bad.app.db, bad.pull.id).map((c) => c.body);
      expect(told.some((b) => b.includes("did not swap in") && b.includes(sha.slice(0, 12)))).toBe(true);
      expect(await commitAt(port)).toBe(OLD);
      bad.app.close();
    } finally {
      delete handover.drain;
      old.stop(true);
    }
  }, 120_000);

  test("a release that reads healthy drains the old process once", async () => {
    const port = await freePort();
    const old = oldForge(port);
    let drained = 0;
    handover.drain = () => {
      drained++;
      old.stop();
    };
    try {
      // The stand-in leaves on its own, so the test strands nothing.
      const s = await setup(true, port, `${STAND_IN}\nsetTimeout(() => process.exit(0), 6000);\n`);
      await releaseOnLand(s.app, s.user, s.repo, s.pull, s.sha);
      expect(drained).toBe(1);
      expect(await commitAt(port)).toBe(s.sha);
      s.app.close();
    } finally {
      endSwap(false);
      delete handover.drain;
      old.stop(true);
    }
  }, 60_000);

  test("two landings close together leave exactly one new process serving", async () => {
    const port = await freePort();
    const old = oldForge(port);
    let drained = 0;
    handover.drain = () => {
      drained++;
      old.stop();
    };
    const long = `${STAND_IN}\nsetTimeout(() => process.exit(0), 8000);\n`;
    try {
      const a = await setup(true, port, long);
      const b = await setup(true, port, long);
      await Promise.all([
        releaseOnLand(a.app, a.user, a.repo, a.pull, a.sha),
        releaseOnLand(b.app, b.user, b.repo, b.pull, b.sha),
      ]);
      expect(drained).toBe(1);
      const seen = new Set<string>();
      for (let i = 0; i < 40; i++) {
        const c = await commitAt(port);
        if (c !== undefined) seen.add(c);
      }
      expect(seen.size).toBe(1);
      expect([a.sha, b.sha]).toContain([...seen][0]!);
      // This process is leaving: a later landing does not start another.
      const c = await setup(true, port, long);
      await releaseOnLand(c.app, c.user, c.repo, c.pull, c.sha);
      expect(drained).toBe(1);
      a.app.close();
      b.app.close();
      c.app.close();
    } finally {
      delete handover.drain;
      endSwap(false);
      old.stop(true);
    }
  }, 90_000);

  test("a process holding the SSH terminal refuses the swap and tells the pull", async () => {
    const port = await freePort();
    const old = oldForge(port);
    let drained = 0;
    handover.drain = () => {
      drained++;
    };
    handover.ssh = true;
    try {
      const s = await setup(true, port, STAND_IN);
      await releaseOnLand(s.app, s.user, s.repo, s.pull, s.sha);
      expect(drained).toBe(0);
      expect(await commitAt(port)).toBe(OLD);
      const told = listComments(s.app.db, s.pull.id).map((c) => c.body);
      expect(told.some((b) => b.includes("did not swap in") && b.includes("SSH"))).toBe(true);
      // Refusing took no turn: with the terminal off, the next swap goes.
      handover.ssh = false;
      expect(beginSwap().ok).toBe(true);
      endSwap(false);
      s.app.close();
    } finally {
      delete handover.drain;
      delete handover.ssh;
      old.stop(true);
    }
  }, 60_000);

  test("with the switch off, a green landing swaps nothing", async () => {
    const port = await freePort();
    let drained = 0;
    handover.drain = () => {
      drained++;
    };
    try {
      const s = await setup(false, port, STAND_IN);
      await releaseOnLand(s.app, s.user, s.repo, s.pull, s.sha);
      expect(drained).toBe(0);
      expect(await commitAt(port)).toBeUndefined();
      s.app.close();
    } finally {
      delete handover.drain;
    }
  }, 60_000);
});
