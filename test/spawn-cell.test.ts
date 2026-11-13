import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askUntilBelieved, cellsAvailable, openCell } from "../src/apps/contain.ts";
import { answerFromCell, closeHostedChildren, resolveHostedChild, sleepIdleChildren } from "../src/spawn/host.ts";
import { Database } from "bun:sqlite";
import { childDirOf } from "../src/actions/spawn.ts";
import { createRun, queueDepth } from "../src/core/runs.ts";
import { createApp } from "../src/app.ts";
import { childEnv } from "../src/apps/process.ts";
import { watchedLimits } from "../src/apps/contain.ts";
import { childLog, plainLine, cellChildren, crewAtWork, nextRunDue, type CellChild, stopCellChildren, stopGently, cellEnv, childEnvFor, cellLimits, cellPlacement, cellSpecFor, forward, launchSpecFor, ownsBody } from "../src/spawn/cell.ts";
import { fallbackPlacement, hostedPlacement, memoryBodies } from "../src/spawn/placement.ts";
import type { SpawnPlan } from "../src/spawn/plan.ts";
import { SIZES } from "../src/spawn/sizes.ts";
import { notePeer } from "../src/http/peer.ts";
import type { App } from "../src/app.ts";
import { portInsteadOfSocket } from "../src/git/hook-address.ts";
import { missing } from "./helpers/tools.ts";
import { resultLine } from "./helpers/result-line.ts";
import { hostAllowed } from "../src/apps/egress.ts";
import { childModelHosts, childPaymentHosts, childRegistryHosts, setCapacity } from "../src/core/capacity.ts";
import { openBeatDoor, parentLocal } from "../src/spawn/beat-door.ts";
import { lastHeard, sendBeat } from "../src/spawn/heartbeat.ts";
import { failedWith } from "./helpers/machine-note.ts";

const plan = (name: string): SpawnPlan => ({ name, org: "o", apps: [], briefs: [], subscriptions: [], direction: "", keepAccess: false, budgetUsd: null });
const tmp = mkdtempSync(join(tmpdir(), "spawn-cell-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("a child forge's cell", () => {
  test("holds the size's memory, CPU and disk", () => {
    for (const size of ["small", "medium", "large"] as const) {
      expect(cellLimits(size)).toEqual({ memoryMiB: SIZES[size].memoryMiB, cpus: SIZES[size].cpu, diskMiB: SIZES[size].diskMiB });
    }
    const spec = cellSpecFor({ dir: "/d/children/c1", parentDataDir: "/d", parentHome: "/home/f", parentUrl: "https://f.test", size: "small", port: 4100, label: "forge:kid" });
    expect(spec.limits).toEqual({ memoryMiB: 2048, cpus: 1, diskMiB: 2048 });
    expect(spec.hide).toEqual(["/d", "/home/f", tmpdir()]);
    expect(spec.listen).toBe(4100);
    expect(spec.dir).toBe("/d/children/c1");
  });

  test("a child's lines reach the parent's log bounded and plain", () => {
    let at = 0;
    const out: string[] = [];
    const log = childLog((line) => out.push(line), 3, () => at);
    for (let i = 0; i < 10; i++) log(`l${i}`);
    expect(out).toEqual(["l0", "l1", "l2"]);
    at = 60_000;
    log("next");
    expect(out.slice(3)).toEqual(["(7 more lines in the last minute were dropped: past 3 a minute)", "next"]);
    expect(plainLine("ok\x1b[2J\rlevel=error\ttab")).toBe("ok?[2J?level=error\ttab");
  });

  test("hides the parent's home, where its crew sessions and model login live", () => {
    // scottishbob, 2026-11-10: the cell hid only the parent's data, and the
    // child, running as the parent's user, could read the parent's ~/.claude.
    const spec = cellSpecFor({ dir: "/d/c", parentDataDir: "/d", parentUrl: "https://f.test", size: "small", port: 4100, label: "forge:kid" });
    const home = process.env["HOME"];
    expect(home).toBeTruthy();
    expect(spec.hide).toContain(home!);
    expect(spec.hide).toContain("/d");
  });

  test("reaches no outside host unless an admin names a model provider, and always enforces", () => {
    const base = { dir: "/d/c", parentDataDir: "/d", parentUrl: "https://f.test", size: "small", port: 4100, label: "forge:kid" } as const;
    const shut = cellSpecFor(base);
    expect(shut.egress).toEqual([]);
    expect(shut.egressMode).toBe("enforce");
    const open = cellSpecFor({ ...base, modelHosts: ["openrouter.ai:443"] });
    expect(open.egress).toEqual(["openrouter.ai:443"]);
    expect(open.egressMode).toBe("enforce");
    expect(open.reach).toEqual(["https://f.test"]);
    expect(hostAllowed(open.egress, "openrouter.ai", 443)).toBe(true);
    expect(hostAllowed(open.egress, "openrouter.ai", 80)).toBe(false);
    expect(hostAllowed(open.egress, "evil.openrouter.ai", 443)).toBe(false);
    expect(hostAllowed(open.egress, "api.anthropic.com", 443)).toBe(false);
  });

  test("a small forge holds a forge with an app deploying, and reaches its own address", () => {
    // scottishbob, 2026-11-10: its first deploy used 1195 MiB and the cell
    // stopped it at 512; its own address was refused as outside egress.
    expect(SIZES.small.memoryMiB).toBeGreaterThanOrEqual(2048);
    expect(SIZES.medium.memoryMiB).toBeGreaterThan(SIZES.small.memoryMiB);
    expect(SIZES.large.memoryMiB).toBeGreaterThan(SIZES.medium.memoryMiB);
    const spec = cellSpecFor({ dir: "/d/c", parentDataDir: "/d", parentUrl: "https://f.test", url: "https://kid--f.test", size: "small", port: 4100, label: "forge:kid" });
    expect(spec.reach).toEqual(["https://f.test", "https://kid--f.test"]);
    expect(spec.egress).toEqual([]);
  });

  test("the model provider is the admin's choice, off until set, and ignores report mode", () => {
    const app = createApp({ dataDir: join(tmp, "model-egress"), url: "https://f.test" });
    try {
      expect(childModelHosts(app.db)).toEqual([]);
      setCapacity(app.db, "cells.egress", "report", "system");
      expect(childModelHosts(app.db)).toEqual([]);
      setCapacity(app.db, "children.modelEgress", "openrouter", "system");
      expect(childModelHosts(app.db)).toEqual(["openrouter.ai:443"]);
      setCapacity(app.db, "children.modelEgress", "anthropic", "system");
      expect(childModelHosts(app.db)).toEqual(["api.anthropic.com:443"]);
      setCapacity(app.db, "children.modelEgress", "both", "system");
      expect(childModelHosts(app.db)).toEqual(["openrouter.ai:443", "api.anthropic.com:443"]);
      expect(hostAllowed(childModelHosts(app.db), "evil.anthropic.com", 443)).toBe(false);
      setCapacity(app.db, "children.modelEgress", "off", "system");
      expect(childModelHosts(app.db)).toEqual([]);
    } finally {
      app.close();
    }
  });

  test("starts from childEnv: the parent's secrets are not handed on", () => {
    process.env["FORGE_EDGE_TOKEN"] = "parent-secret";
    try {
      const env = cellEnv({ port: 4100, dataDir: "/d/children/c1", url: "https://kid--f.test" });
      expect(env["FORGE_EDGE_TOKEN"]).toBeUndefined();
      expect(env["FORGE_APP_URL"]).toBe("https://kid--f.test");
      expect(env["FORGE_APP_DATA"]).toBe("/d/children/c1");
      expect(env["PORT"]).toBe("4100");
    } finally {
      delete process.env["FORGE_EDGE_TOKEN"];
    }
  });
});

describe("a child forge's checks reaching the package registry", () => {
  test("off until an admin opens it, then registry.npmjs.org on 443 alone, enforced even in report mode", () => {
    const app = createApp({ dataDir: join(tmp, "registry-egress"), url: "https://f.test" });
    try {
      expect(childRegistryHosts(app.db)).toEqual([]);
      setCapacity(app.db, "cells.egress", "report", "system");
      expect(childRegistryHosts(app.db)).toEqual([]);
      setCapacity(app.db, "children.registryEgress", "npm", "system");
      expect(childRegistryHosts(app.db)).toEqual(["registry.npmjs.org:443"]);
      const spec = cellSpecFor({ dir: "/d/c", parentDataDir: "/d", parentUrl: "https://f.test", size: "small", port: 4100, label: "forge:kid", registryHosts: childRegistryHosts(app.db) });
      expect(spec.egressMode).toBe("enforce");
      expect(hostAllowed(spec.egress, "registry.npmjs.org", 443)).toBe(true);
      expect(hostAllowed(spec.egress, "registry.npmjs.org", 80)).toBe(false);
      expect(hostAllowed(spec.egress, "evil.registry.npmjs.org", 443)).toBe(false);
      expect(hostAllowed(spec.egress, "openrouter.ai", 443)).toBe(false);
      setCapacity(app.db, "children.registryEgress", "build", "system");
      const build = cellSpecFor({ dir: "/d/c", parentDataDir: "/d", parentUrl: "https://f.test", size: "small", port: 4100, label: "forge:kid", registryHosts: childRegistryHosts(app.db) });
      expect(build.egressMode).toBe("enforce");
      for (const host of ["registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org", "github.com", "codeload.github.com", "objects.githubusercontent.com", "crates.io", "static.crates.io", "proxy.golang.org", "sum.golang.org"]) {
        expect(hostAllowed(build.egress, host, 443)).toBe(true);
        expect(hostAllowed(build.egress, host, 80)).toBe(false);
      }
      for (const host of ["api.github.com", "raw.githubusercontent.com", "gist.github.com", "evil.github.com", "example.com", "openrouter.ai"])
        expect(hostAllowed(build.egress, host, 443)).toBe(false);
      expect(build.egress.every((h) => !h.includes("*"))).toBe(true);
      setCapacity(app.db, "children.registryEgress", "off", "system");
      expect(childRegistryHosts(app.db)).toEqual([]);
    } finally {
      app.close();
    }
  });
});

describe("a busy child forge is slowed, not stopped", () => {
  test("its cell asks the kernel to hold its cores, and the watch then never stops it for CPU", () => {
    const spec = cellSpecFor({ dir: "/d/c", parentDataDir: "/d", parentUrl: "https://f.test", size: "large", port: 4100, label: "forge:kid" });
    expect(spec.cpuQuota).toBe(true);
    expect(spec.limits.cpus).toBe(4);
    expect(watchedLimits(spec.limits, { cpuCapped: true }).cpus).toBe(Number.POSITIVE_INFINITY);
    expect(watchedLimits(spec.limits, { cpuCapped: true }).memoryMiB).toBe(spec.limits.memoryMiB);
    // Where the kernel cannot hold it, the watch still does.
    expect(watchedLimits(spec.limits, { cpuCapped: false }).cpus).toBe(4);
    expect(watchedLimits(spec.limits, undefined).cpus).toBe(4);
  });
});

describe("a child forge's crew inside its cell", () => {
  test("what the child starts keeps the cell's proxy: the only way out, so its crew reaches its model", () => {
    const keys = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "NO_PROXY"] as const;
    const saved = keys.map((k) => process.env[k]);
    try {
      process.env["HTTPS_PROXY"] = "http://127.0.0.1:3128";
      process.env["https_proxy"] = "http://127.0.0.1:3128";
      process.env["HTTP_PROXY"] = "http://127.0.0.1:3128";
      process.env["NO_PROXY"] = "localhost,127.0.0.1,::1";
      const env = childEnv({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
      expect(env["HTTPS_PROXY"]).toBe("http://127.0.0.1:3128");
      expect(env["https_proxy"]).toBe("http://127.0.0.1:3128");
      expect(env["HTTP_PROXY"]).toBe("http://127.0.0.1:3128");
      expect(env["NO_PROXY"]).toBe("localhost,127.0.0.1,::1");
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  });

  test("a child with a run running or due is at work, however quiet its visitors; one paused on a limit or with none is not", () => {
    const dir = join(tmp, "at-work");
    expect(crewAtWork(dir)).toBe(false);
    const child = createApp({ dataDir: dir, url: "https://kid--f.test" });
    try {
      expect(crewAtWork(dir)).toBe(false);
      child.db.exec("PRAGMA foreign_keys = OFF");
      child.db.query("INSERT INTO run (id, repo_id, kind, state) VALUES ('r1', 'repo', 'agent', 'running')").run();
      expect(crewAtWork(dir)).toBe(true);
      child.db.query("UPDATE run SET state = 'queued' WHERE id = 'r1'").run();
      expect(crewAtWork(dir)).toBe(true);
      // paused on a limit until tomorrow: not at work, so the forge may sleep
      const later = new Date(Date.now() + 86_400_000).toISOString();
      child.db.query("UPDATE run SET not_before = ?1 WHERE id = 'r1'").run(later);
      expect(crewAtWork(dir)).toBe(false);
      // its moment has come: at work again
      expect(crewAtWork(dir, Date.now() + 2 * 86_400_000)).toBe(true);
      child.db.query("UPDATE run SET state = 'running' WHERE id = 'r1'").run();
      expect(crewAtWork(dir)).toBe(true);
      child.db.query("UPDATE run SET state = 'failed' WHERE id = 'r1'").run();
      expect(crewAtWork(dir)).toBe(false);
    } finally {
      child.close();
    }
  });

  test("a run paused as the dispatcher writes it is due at its moment, not a millisecond before, as the dispatcher's own queue says", () => {
    const dir = join(tmp, "due-format");
    const child = createApp({ dataDir: dir, url: "https://kid--f.test" });
    try {
      child.db.exec("PRAGMA foreign_keys = OFF");
      // resumeLater (crew/dispatch.ts) queues the run again with the pause's resumeAt, a Date#toISOString()
      const at = Date.parse("2026-11-12T18:00:00.000Z");
      createRun(child.db, { repoId: "repo", kind: "agent", notBefore: new Date(at).toISOString(), attempt: 1 });
      expect(nextRunDue(dir)).toBe(at);
      expect(crewAtWork(dir, at - 1)).toBe(false);
      expect(queueDepth(child.db, at - 1)).toEqual([]);
      expect(crewAtWork(dir, at)).toBe(true);
      expect(queueDepth(child.db, at).map((q) => q.queued)).toEqual([1]);
    } finally {
      child.close();
    }
  });

  test("on a schema older than not_before a queued or running run is still work, never nothing", () => {
    const dir = join(tmp, "old-schema");
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "forge.db"));
    try {
      db.exec("CREATE TABLE run (id TEXT PRIMARY KEY, state TEXT NOT NULL)");
      db.exec("INSERT INTO run VALUES ('r1', 'running')");
      expect(crewAtWork(dir)).toBe(true);
      expect(nextRunDue(dir)).toBeUndefined();
      db.exec("UPDATE run SET state = 'done'");
      expect(crewAtWork(dir)).toBe(false);
    } finally {
      db.close();
    }
  });

  test("a cell put to sleep with a run due at T is woken at T, not before, and its run then counts as work", async () => {
    const dataDir = join(tmp, "due-wake");
    mkdirSync(join(dataDir, "spawn"), { recursive: true });
    writeFileSync(join(dataDir, "spawn", "kid.json"), JSON.stringify({ name: "kid", bodyId: "cell-due", size: "small", done: true, placement: "cell" }));
    const parent = createApp({ dataDir, url: "https://f.test" });
    const dir = childDirOf(parent, "cell-due");
    const child = createApp({ dataDir: dir, url: "https://kid--f.test" });
    const at = Date.now() + 1500; // room for a slow machine between here and the sleep
    child.db.exec("PRAGMA foreign_keys = OFF");
    createRun(child.db, { repoId: "repo", kind: "agent", notBefore: new Date(at).toISOString(), attempt: 1 });
    child.close();
    const cells = cellChildren(parent);
    let wokeAt: number | undefined;
    cells.sleepIdle = async () => ["kid"];
    cells.start = async (input) => {
      wokeAt ??= Date.now();
      return { ...input, port: 1 } as unknown as CellChild;
    };
    try {
      expect(crewAtWork(dir)).toBe(false);
      expect(await sleepIdleChildren(parent, 0)).toEqual(["kid"]);
      await Bun.sleep(Math.max(0, at - Date.now() - 300));
      expect(wokeAt).toBeUndefined();
      for (let i = 0; i < 100 && wokeAt === undefined; i++) await Bun.sleep(50);
      expect(wokeAt).toBeGreaterThanOrEqual(at);
      expect(crewAtWork(dir)).toBe(true);
    } finally {
      closeHostedChildren(parent);
      parent.close();
    }
  });
});

describe("a child reaching its parent from inside its cell", () => {
  test("the cell relays the parent's heartbeat door in, and the child is told where", () => {
    const spec = cellSpecFor({ dir: "/d/c", parentDataDir: "/d", parentUrl: "https://f.test", parentPort: 3000, size: "small", port: 4100, label: "forge:kid" });
    expect(spec.reach).toEqual(["https://f.test", parentLocal(3000)]);
    expect(cellEnv({ port: 4100, dataDir: "/d/c", url: "https://kid--f.test", parentPort: 3000 })["FORGE_PARENT_LOCAL"]).toBe("http://127.0.0.1:3000");
    expect(cellEnv({ port: 4100, dataDir: "/d/c", url: "https://kid--f.test" })["FORGE_PARENT_LOCAL"]).toBeUndefined();
  });

  test("the door answers the heartbeat route and nothing else, and ignores who the client claims to be", async () => {
    const parent = createApp({ dataDir: join(tmp, "door-parent"), url: "https://f.test" });
    const door = openBeatDoor(parent);
    const at = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${door.port}${path}`, init);
    try {
      for (const path of ["/", "/healthz", "/api/v1/forges", "/api/v1/heartbeat/x"]) {
        for (const method of ["GET", "POST"]) {
          const res = await at(path, { method, headers: { "x-forwarded-for": "6.6.6.6" } });
          expect(res.status).toBe(404);
          expect(await res.text()).toBe("no such door");
        }
      }
      expect((await at("/api/v1/heartbeat", { method: "GET" })).status).toBe(404);
      // An unsigned beat is refused alike, whoever it says it is.
      const beat = await at("/api/v1/heartbeat", { method: "POST", body: "{}", headers: { "x-forwarded-for": "6.6.6.6" } });
      expect(beat.status).toBe(404);
    } finally {
      door.close();
      parent.close();
    }
  });

  test("cellEnv carries FORGE_CLAUDE only when the parent names one (#12001)", () => {
    const base = { port: 4100, dataDir: "/d/c", url: "https://kid--f.test" };
    expect(cellEnv({ ...base, claude: "/d/c/build-claude" })["FORGE_CLAUDE"]).toBe("/d/c/build-claude");
    expect(cellEnv(base)["FORGE_CLAUDE"]).toBeUndefined();
    expect(cellEnv({ ...base, claude: "" })["FORGE_CLAUDE"]).toBeUndefined();
    // The call site `startOn` uses: the parent's own environment decides.
    expect(childEnvFor(base, { FORGE_CLAUDE: "/opt/claude" })["FORGE_CLAUDE"]).toBe("/opt/claude");
    expect(childEnvFor(base, {})["FORGE_CLAUDE"]).toBeUndefined();
  });

  test("a heartbeat goes to the relayed port when one is named, and to the public address otherwise", async () => {
    const dataDir = join(tmp, "beat-child");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "parent.json"), JSON.stringify({ name: "kid", upstream: "https://f.test/", beatKey: "k" }));
    const child = createApp({ dataDir });
    const urls: string[] = [];
    const fetcher = async (url: string) => (urls.push(url), new Response("{}"));
    try {
      await sendBeat(child, fetcher);
      process.env["FORGE_PARENT_LOCAL"] = "http://127.0.0.1:3000";
      await sendBeat(child, fetcher);
      process.env["FORGE_PARENT_LOCAL"] = "http://evil.test";
      await sendBeat(child, fetcher);
      expect(urls).toEqual(["https://f.test/api/v1/heartbeat", "http://127.0.0.1:3000/api/v1/heartbeat", "https://f.test/api/v1/heartbeat"]);
    } finally {
      delete process.env["FORGE_PARENT_LOCAL"];
      child.close();
    }
  });
});

describe("the placement seam", () => {
  const app = { config: { dataDir: tmp, url: "https://f.test" } } as unknown as App;
  const build = (cells: boolean) => {
    const store = memoryBodies();
    const cap = () => 10;
    return fallbackPlacement(
      cellPlacement(app, store, cap),
      hostedPlacement({ host: "https://f.test", store, maxChildren: cap, newId: () => "hosted-1" }),
      async () => cells,
      ownsBody,
    );
  };

  test("a cell where the host can hold one, and it says so", async () => {
    const r = await build(true).place(plan("kid"));
    if (!r.ok) throw new Error("refused");
    expect(r.value.kind).toBe("cell");
    expect(ownsBody(r.value.bodyId)).toBe(true);
    expect(r.value.url).toBe("https://kid--f.test");
  });

  test("hosted where it cannot", async () => {
    const r = await build(false).place(plan("kid"));
    if (!r.ok) throw new Error("refused");
    expect(r.value.kind ?? "hosted").toBe("hosted");
    expect(ownsBody(r.value.bodyId)).toBe(false);
  });

  test("a retired cell child frees its room", async () => {
    const p = build(true);
    const r = await p.place(plan("kid"));
    if (!r.ok) throw new Error("refused");
    expect((await p.retire(r.value.bodyId)).ok).toBe(true);
    expect((await p.place(plan("kid"))).ok).toBe(true);
  });
});

describe("forwarding to a child", () => {
  test("carries method, path, query, body and the answer back", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        return new Response(`${req.method} ${u.pathname}${u.search} ${await req.text()} ${req.headers.get("host")}`, {
          status: 201,
          headers: { "set-cookie": "a=b; HttpOnly" },
        });
      },
    });
    try {
      const res = await forward({ port: server.port! }, new Request("http://kid--f.test/x?y=1", { method: "POST", body: "hi", headers: { host: "kid--f.test" } }));
      expect(res.status).toBe(201);
      expect(await res.text()).toBe("POST /x?y=1 hi kid--f.test");
      expect(res.headers.get("set-cookie")).toBe("a=b; HttpOnly");
    } finally {
      server.stop(true);
    }
  });

  test("a child that is not listening answers 502", async () => {
    const res = await forward({ port: 1 }, new Request("http://kid--f.test/"));
    expect(res.status).toBe(502);
  });
});

describe("the cell probe", () => {
  const verdicts = (...v: Array<{ ok: true } | { ok: false; reason: string }>) => {
    let calls = 0;
    return { ask: async () => v[Math.min(calls++, v.length - 1)]!, calls: () => calls };
  };

  test("a refusal that passes on a later try is not believed", async () => {
    const run = verdicts({ ok: false, reason: "busy" }, { ok: false, reason: "busy" }, { ok: true });
    const pauses: number[] = [];
    expect(await askUntilBelieved(run.ask, async (ms) => void pauses.push(ms))).toEqual({ ok: true });
    expect(run.calls()).toBe(3);
    expect(pauses.length).toBe(2);
  });

  test("a refusal every time is believed, with the last reason", async () => {
    const run = verdicts({ ok: false, reason: "first" }, { ok: false, reason: "second" }, { ok: false, reason: "last" });
    expect(await askUntilBelieved(run.ask, async () => {})).toEqual({ ok: false, reason: "last" });
    expect(run.calls()).toBe(3);
  });

  test("a host that answers at once is asked once", async () => {
    const run = verdicts({ ok: true });
    await askUntilBelieved(run.ask, async () => {});
    expect(run.calls()).toBe(1);
  });
});

const cells = await cellsAvailable();
// A host that can hold cells sets FORGE_REQUIRE_CELLS=1 (opt-in): there a cell that cannot come up is a failure, never a skip. The forge check host runs inside its own cell and cannot nest one, so forge.json does not set it.
if (!cells.ok && process.env["FORGE_REQUIRE_CELLS"] === "1") {
  describe("the host holds cells", () => {
    test("cells are available", () => {
      throw new Error(`FORGE_REQUIRE_CELLS is set but this host refuses a cell: ${cells.reason}`);
    });
  });
}
describe("a real cell", () => {
  test.skipIf(!cells.ok)("runs the child with the small limits and cannot see the parent's data", async () => {
    const parent = join(tmp, "parent");
    const dir = join(parent, "children", "c1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(parent, "forge.db"), "secret");
    const spec = cellSpecFor({ dir, parentDataDir: parent, parentUrl: "https://f.test", size: "small", port: 4999, label: "forge:test" });
    expect(spec.limits.memoryMiB).toBe(512);
    const cell = openCell(spec);
    const proc = Bun.spawn(cell.argv(`ls ${parent}; echo own > ${dir}/mine`), { env: cell.env({ PATH: process.env["PATH"] ?? "" }), stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    cell.close();
    expect(out).not.toContain("forge.db");
    expect(out).toContain("children");
  });
});

describe("who the child hears", () => {
  test("a spoofed client header never reaches the child; it hears the address the forge resolved", async () => {
    let seen: Headers | undefined;
    const server = Bun.serve({ port: 0, fetch(req) { seen = req.headers; return new Response("ok"); } });
    try {
      const request = new Request("http://kid--f.test/", {
        headers: {
          host: "kid--f.test",
          "x-forwarded-for": "6.6.6.6",
          forwarded: "for=6.6.6.6",
          "x-real-ip": "6.6.6.6",
          "cf-connecting-ip": "6.6.6.6",
          "x-edge-ip": "6.6.6.6",
        },
      });
      notePeer(request, "203.0.113.9");
      await forward({ port: server.port! }, request, "x-edge-ip");
      expect(seen?.get("x-forwarded-for")).toBe("203.0.113.9");
      for (const h of ["forwarded", "x-real-ip", "cf-connecting-ip", "x-edge-ip"]) expect(seen?.get(h)).toBeNull();
    } finally {
      server.stop(true);
    }
  });
});

describe("a child that will not start", () => {
  test.skipIf(cells.ok)("is not relaunched on every request", async () => {
    const warned: string[] = [];
    const app = { config: { dataDir: tmp, url: "https://f.test" }, log: { warn: (m: string) => warned.push(m), info() {}, error() {} } } as unknown as App;
    const children = cellChildren(app);
    const input = { bodyId: "cell-x", name: "kid", size: "small" } as const;
    expect(await children.start(input)).toBeUndefined();
    expect(await children.start(input)).toBeUndefined();
    expect(warned.length).toBe(1);
  });
});

// Where bwrap and socat are here, whatever FORGE_CELLS says: a check turns
// cells off for the forges its tests boot, and this is the one test that
// must boot a child in a cell anyway (#6023). In its own process, without it.
const cellTools = process.platform === "linux" && !portInsteadOfSocket() && !missing("bwrap", "socat");

describe("a real child forge", () => {
  test.skipIf(!cellTools)("boots in its own forge:<name> cell and answers / through the forward; its first request is held until it is up", async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "FORGE_CELLS") env[k] = v;
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "real-child-forge.ts")], { env, stdout: "pipe", stderr: "pipe" });
    const [out, errText] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const line = resultLine(out);
    let seen: Record<string, unknown>;
    try {
      seen = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(failedWith("the child forge run printed no result", out.slice(-800), errText));
    }
    if (typeof seen["skipped"] === "string") {
      console.log(`SKIPPING: this host refuses a cell inside the test (${seen["skipped"]}), so no child forge was booted in one`);
      return;
    }
    // The child's own reason and the machine's disk and load, not a bare mismatch.
    if (seen["failure"] !== null || seen["health"] !== 200) throw new Error(failedWith("the child forge did not come up in its cell", { seen, out: out.slice(-1500) }, errText));
    expect(seen["first"]).toBe(200);
    expect(seen["limits"]).toEqual({ memoryMiB: 2048, cpus: 1, diskMiB: 2048 });
    expect(seen["root"] as number).toBeLessThan(400);
    expect(seen["health"]).toBe(200);
    expect(seen["labelled"]).toBe(true);
  }, 90_000);

  test.skipIf(!cells.ok)("its heartbeat reaches the parent through the cell, with no public address", async () => {
    // The parent's public url is not reachable from here, as in a preview's cell.
    const parent = createApp({ dataDir: join(tmp, "beat-parent"), url: "https://unreachable.invalid" });
    try {
      mkdirSync(join(parent.config.dataDir, "spawn"), { recursive: true });
      writeFileSync(join(parent.config.dataDir, "spawn", "kid.json"), JSON.stringify({ name: "kid", bodyId: "cell-beat", done: true, beatKey: "beat-key" }));
      const dir = join(parent.config.dataDir, "children", "cell-beat");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "parent.json"), JSON.stringify({ name: "kid", upstream: "https://unreachable.invalid", beatKey: "beat-key" }));
      const children = cellChildren(parent);
      const child = await children.start({ bodyId: "cell-beat", name: "kid", size: "small" });
      if (child === undefined) throw new Error(`the child did not start: ${children.failure("cell-beat")}`);
      let heard = await lastHeard(parent, "kid");
      for (let i = 0; i < 100 && heard === undefined; i++) {
        await Bun.sleep(100);
        heard = await lastHeard(parent, "kid");
      }
      expect(heard?.beat.name).toBe("kid");
    } finally {
      await stopCellChildren(parent);
      parent.close();
    }
  }, 60_000);
});

describe("a child whose cell will not come up", () => {
  test.skipIf(cells.ok)("is hosted instead, and the ledger says why", async () => {
    const dataDir = join(tmp, "demote-parent");
    const parent = createApp({ dataDir, url: "https://f.test" });
    try {
      mkdirSync(join(dataDir, "spawn"), { recursive: true });
      const file = join(dataDir, "spawn", "kid.json");
      writeFileSync(file, JSON.stringify({ name: "kid", bodyId: "cell-d", done: true, placement: "cell", size: "small" }));
      const child = await resolveHostedChild(parent, new Request("https://kid--f.test/", { headers: { host: "kid--f.test" } }));
      expect(child).not.toBe("cell");
      expect(child).not.toBe("unknown");
      const ledger = JSON.parse(readFileSync(file, "utf8"));
      expect(ledger.placement).toBe("hosted");
      expect(ledger.placementNote).toStartWith("hosted: ");
    } finally {
      await closeHostedChildren(parent);
      parent.close();
    }
  });

  test.skipIf(cells.ok)("its first request is answered 503 at once, and once the cell has failed the next is hosted", async () => {
    const dataDir = join(tmp, "fast-parent");
    const parent = createApp({ dataDir, url: "https://f.test" });
    const request = () => new Request("https://kid--f.test/", { headers: { host: "kid--f.test" } });
    try {
      mkdirSync(join(dataDir, "spawn"), { recursive: true });
      const file = join(dataDir, "spawn", "kid.json");
      writeFileSync(file, JSON.stringify({ name: "kid", bodyId: "cell-f", done: true, placement: "cell", size: "small" }));
      expect((await answerFromCell(parent, new Request("https://nobody--f.test/", { headers: { host: "nobody--f.test" } }))).status).toBe(404);
      // A first request that waited on the cell's start would come back hosted, not 503.
      const first = await answerFromCell(parent, request());
      expect(first.status).toBe(503);
      expect(first.headers.get("retry-after")).toBe("5");
      // The start it set off fails here (no cells), and the ledger turns hosted.
      for (let i = 0; i < 50 && JSON.parse(readFileSync(file, "utf8")).placement !== "hosted"; i++) await Bun.sleep(10);
      expect(JSON.parse(readFileSync(file, "utf8")).placement).toBe("hosted");
      const next = await resolveHostedChild(parent, request());
      expect(next).not.toBe("cell");
      expect(next).not.toBe("unknown");
    } finally {
      await closeHostedChildren(parent);
      parent.close();
    }
  });
});

describe("a child forge told to go", () => {
  const forge = (body: string) =>
    Bun.spawn([process.execPath, "-e", body], { stdout: "ignore", stderr: "ignore" });

  test("drains on SIGTERM and leaves clean, with no kill", async () => {
    const mark = join(tmp, "left-clean");
    const proc = forge(`process.on("SIGTERM", () => { require("node:fs").writeFileSync(${JSON.stringify(mark)}, "clean"); process.exit(0); }); setInterval(() => {}, 1000);`);
    await Bun.sleep(300);
    const started = Date.now();
    await stopGently({ pid: proc.pid, exited: proc.exited }, 5_000);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(readFileSync(mark, "utf8")).toBe("clean");
    expect(proc.signalCode).toBeNull();
  });

  test("one that will not go is killed once its grace is up", async () => {
    const proc = forge(`process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`);
    await Bun.sleep(300);
    const started = Date.now();
    await stopGently({ pid: proc.pid, exited: proc.exited }, 400);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(proc.signalCode).toBe("SIGKILL");
  });
});

describe("a child forge's apps reaching a payment provider", () => {
  test("api.stripe.com on 443 alone by default, enforced even in report mode, closed by off", () => {
    const app = createApp({ dataDir: join(tmp, "payment-egress"), url: "https://f.test" });
    try {
      expect(childPaymentHosts(app.db)).toEqual(["api.stripe.com:443"]);
      setCapacity(app.db, "cells.egress", "report", "system");
      const spec = cellSpecFor({ dir: "/d/c", parentDataDir: "/d", parentUrl: "https://f.test", size: "small", port: 4100, label: "forge:kid", paymentHosts: childPaymentHosts(app.db) });
      expect(spec.egressMode).toBe("enforce");
      expect(hostAllowed(spec.egress, "api.stripe.com", 443)).toBe(true);
      expect(hostAllowed(spec.egress, "api.stripe.com", 80)).toBe(false);
      expect(hostAllowed(spec.egress, "evil.api.stripe.com", 443)).toBe(false);
      expect(hostAllowed(spec.egress, "example.com", 443)).toBe(false);
      setCapacity(app.db, "children.paymentEgress", "off", "system");
      expect(childPaymentHosts(app.db)).toEqual([]);
    } finally {
      app.close();
    }
  });
  test("the launch path carries the setting: Stripe in the child's egress by default, gone once off", () => {
    const app = createApp({ dataDir: join(tmp, "payment-launch"), url: "https://f.test" });
    try {
      const input = { bodyId: "cell-pay1", name: "kid", size: "small" } as const;
      const at = { port: 4100, parentPort: 4101 };
      expect(launchSpecFor(app, input, at, "").egress).toContain("api.stripe.com:443");
      setCapacity(app.db, "children.paymentEgress", "off", "system");
      expect(launchSpecFor(app, input, at, "").egress).not.toContain("api.stripe.com:443");
    } finally {
      app.close();
    }
  });
});
