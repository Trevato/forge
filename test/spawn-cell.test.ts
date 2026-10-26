import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cellsAvailable, openCell } from "../src/apps/contain.ts";
import { closeHostedChildren, resolveHostedChild } from "../src/spawn/host.ts";
import { createApp } from "../src/app.ts";
import { cellChildren, stopCellChildren, cellEnv, cellLimits, cellPlacement, cellSpecFor, forward, ownsBody } from "../src/spawn/cell.ts";
import { fallbackPlacement, hostedPlacement, memoryBodies } from "../src/spawn/placement.ts";
import type { SpawnPlan } from "../src/spawn/plan.ts";
import { SIZES } from "../src/spawn/sizes.ts";
import { notePeer } from "../src/http/peer.ts";
import type { App } from "../src/app.ts";

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

const cells = await cellsAvailable();
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

describe("a real child forge", () => {
  test.skipIf(!cells.ok)("boots in its cell and answers /healthz through the forward", async () => {
    const parent = createApp({ dataDir: join(tmp, "real-parent"), url: "https://f.test" });
    try {
      const children = cellChildren(parent);
      const child = await children.start({ bodyId: "cell-real", name: "kid", size: "small" });
      expect(children.failure("cell-real")).toBeUndefined();
      if (child === undefined) throw new Error(`the child did not start: ${children.failure("cell-real")}`);
      expect(child.limits).toEqual({ memoryMiB: 512, cpus: 1, diskMiB: 2048 });
      const res = await forward(child, new Request("http://kid--f.test/healthz", { headers: { host: "kid--f.test" } }));
      expect(res.status).toBe(200);
      await children.stop("cell-real");
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
});
