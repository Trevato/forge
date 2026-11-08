import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askUntilBelieved, cellsAvailable, openCell } from "../src/apps/contain.ts";
import { answerFromCell, closeHostedChildren, resolveHostedChild } from "../src/spawn/host.ts";
import { createApp } from "../src/app.ts";
import { cellChildren, stopCellChildren, cellEnv, cellLimits, cellPlacement, cellSpecFor, forward, ownsBody } from "../src/spawn/cell.ts";
import { fallbackPlacement, hostedPlacement, memoryBodies } from "../src/spawn/placement.ts";
import type { SpawnPlan } from "../src/spawn/plan.ts";
import { SIZES } from "../src/spawn/sizes.ts";
import { notePeer } from "../src/http/peer.ts";
import type { App } from "../src/app.ts";
import { portInsteadOfSocket } from "../src/git/hook-address.ts";
import { missing } from "./helpers/tools.ts";
import { hostAllowed } from "../src/apps/egress.ts";
import { childModelHosts, setCapacity } from "../src/core/capacity.ts";
import { openBeatDoor, parentLocal } from "../src/spawn/beat-door.ts";
import { lastHeard, sendBeat } from "../src/spawn/heartbeat.ts";

const plan = (name: string): SpawnPlan => ({ name, org: "o", apps: [], briefs: [], subscriptions: [], direction: "", keepAccess: false, budgetUsd: null });
const tmp = mkdtempSync(join(tmpdir(), "spawn-cell-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("a child forge's cell", () => {
  test("holds the size's memory, CPU and disk", () => {
    for (const size of ["small", "medium", "large"] as const) {
      expect(cellLimits(size)).toEqual({ memoryMiB: SIZES[size].memoryMiB, cpus: SIZES[size].cpu, diskMiB: SIZES[size].diskMiB });
    }
    const spec = cellSpecFor({ dir: "/d/children/c1", parentDataDir: "/d", parentUrl: "https://f.test", size: "small", port: 4100, label: "forge:kid" });
    expect(spec.limits).toEqual({ memoryMiB: 512, cpus: 1, diskMiB: 2048 });
    expect(spec.hide).toEqual(["/d"]);
    expect(spec.listen).toBe(4100);
    expect(spec.dir).toBe("/d/children/c1");
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

  test("the model provider is the admin's choice, off until set, and ignores report mode", () => {
    const app = createApp({ dataDir: join(tmp, "model-egress"), url: "https://f.test" });
    try {
      expect(childModelHosts(app.db)).toEqual([]);
      setCapacity(app.db, "cells.egress", "report", "system");
      expect(childModelHosts(app.db)).toEqual([]);
      setCapacity(app.db, "children.modelEgress", "openrouter", "system");
      expect(childModelHosts(app.db)).toEqual(["openrouter.ai:443"]);
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
  test.skipIf(!cellTools)("boots in its own forge:<name> cell and answers / through the forward; its first request does not wait for it", async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "FORGE_CELLS") env[k] = v;
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "real-child-forge.ts")], { env, stdout: "pipe", stderr: "pipe" });
    const [out, errText] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const line = out.trim().split("\n").pop() ?? "";
    let seen: Record<string, unknown>;
    try {
      seen = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`the child forge run printed no result: ${out.slice(-800)} ${errText.slice(-800)}`);
    }
    if (typeof seen["skipped"] === "string") {
      console.log(`SKIPPING: this host refuses a cell inside the test (${seen["skipped"]}), so no child forge was booted in one`);
      return;
    }
    expect(seen["failure"]).toBeNull();
    expect(seen["first"]).toBe(503);
    expect(seen["firstMs"] as number).toBeLessThan(1_000);
    expect(seen["limits"]).toEqual({ memoryMiB: 512, cpus: 1, diskMiB: 2048 });
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
