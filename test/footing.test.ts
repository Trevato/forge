/**
 * What the forge stands on (#11685): the table in docs/OPERATING.md is the
 * declared list exactly; the probe places each piece on the node the kube API
 * shows it on and marks every piece off the forge's node a risk; what the
 * cluster cannot show keeps its declared machine and says why; /system shows
 * it under one heading, and the MCP `system` tool answers it to an admin only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  BREAK_STEPS,
  FOOTING,
  declaredFooting,
  footingCache,
  footingTable,
  ownedBy,
  probeFooting,
  riskLines,
  type Footing,
} from "../src/system/footing.ts";
import { footingSection } from "../src/web/pages/system.ts";
import { getUserByName, type User } from "../src/core/users.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import { footingLines, footingScreen } from "../src/tui/screens/footing.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const cred = { server: "https://kube.test", token: "t", namespace: "forge" };
const pod = (name: string, node: string, phase = "Running") => ({ metadata: { name }, spec: { nodeName: node }, status: { phase } });

/**
 * A fake kube API as the steward found it on 2026-11-12: the forge and both tunnels on vxrail-1,
 * the rest on pg-grand, minio forbidden; Traefik moved to vxrail-1.
 */
function fakeKube(over: Record<string, unknown> = {}) {
  const answers: Record<string, unknown> = {
    "/api/v1/namespaces/forge/pods/forge-7d9f8c6b5-abcde": { spec: { nodeName: "vxrail-1" } },
    "/api/v1/nodes": {
      items: [
        { metadata: { name: "pg-grand", labels: { "node-role.kubernetes.io/control-plane": "true" } } },
        { metadata: { name: "vxrail-1", labels: { "plat.sh/site": "vxrail" } } },
      ],
    },
    "/api/v1/namespaces/standby/pods": {
      items: [pod("cloudflared-6c7b9d8f4-x2x9z", "vxrail-1"), pod("cloudflared-forge-home-5f6d7c8b9-q1w2e", "vxrail-1"), pod("cloudflared-forge-home-5f6d7c8b9-r3t4y", "vxrail-1")],
    },
    "/api/v1/namespaces/forge/pods": { items: [pod("forge-7d9f8c6b5-abcde", "vxrail-1"), pod("forge-signup-gate-6d5c4b3a2-sgate", "pg-grand")] },
    "/api/v1/namespaces/kube-system/pods": { items: [pod("traefik-5b8d9c7f6-zzzzz", "vxrail-1"), pod("coredns-1234567890-aaaaa", "pg-grand")] },
    "/api/v1/namespaces/mcp/pods": { items: [pod("plat-auth-7f8e9d6c5-abcde", "pg-grand")] },
    "/api/v1/namespaces/forgejo/pods": { items: [pod("forgejo-0", "pg-grand"), pod("forgejo-db-1", "pg-grand")] },
    "/api/v1/namespaces/flux-system/pods": { items: [pod("source-controller-6b5d4c3f2-qwert", "pg-grand")] },
    "/api/v1/namespaces/backup/pods": { items: [pod("lane-forge-29000000-abcde", "pg-grand", "Succeeded")] },
    "/api/v1/namespaces/minio/pods": 403,
    "/api/v1/namespaces/cnpg-system/pods": { items: [pod("cnpg-controller-manager-7d8f9b6c5-mnbvc", "pg-grand")] },
    ...over,
  };
  const seen: string[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const path = url.slice(cred.server.length);
    seen.push(path);
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer t");
    expect(init.method).toBe("GET");
    const a = answers[path];
    if (a === undefined) return new Response("{}", { status: 404 });
    if (typeof a === "number") return new Response("{}", { status: a });
    return Response.json(a);
  };
  return { fetch, seen };
}

const byId = (f: Footing, id: string) => f.rows.find((r) => r.id === id)!;

describe("the table in docs/OPERATING.md", () => {
  test("is footingTable() exactly, between the markers", async () => {
    const doc = await readFile(join(import.meta.dir, "..", "docs", "OPERATING.md"), "utf8");
    const m = doc.match(/<!-- footing:start[^>]*-->\n([\s\S]*?)\n<!-- footing:end -->/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(footingTable());
    expect(doc).toContain("## What the forge stands on");
  });
  test("every need (a) to (e) has a piece; every pg-grand piece names an issue that removes it and the step it breaks at", () => {
    for (const need of ["answer", "sign-in", "build", "release", "backup"]) expect(FOOTING.some((p) => p.need === need)).toBe(true);
    for (const p of FOOTING.filter((p) => p.machine === "pg-grand")) {
      expect(p.issues.length).toBeGreaterThan(0);
      expect(p.breaks! >= 1 && p.breaks! <= BREAK_STEPS.length).toBe(true);
    }
    for (const p of FOOTING.filter((p) => p.machine === "vxrail")) expect(p.breaks).toBeUndefined();
    // Every step of the break order has a piece behind it.
    for (let i = 1; i <= BREAK_STEPS.length; i++) expect(FOOTING.some((p) => p.breaks === i)).toBe(true);
    expect(new Set(FOOTING.map((p) => p.id)).size).toBe(FOOTING.length);
  });
  test("the doc names both machines and escapes what markdown would read as a tag", async () => {
    const t = footingTable();
    expect(t).toContain("- **pg-grand**: DigitalOcean.");
    expect(t).toContain("- **vxrail**: ");
    expect(t).toContain("forge:&lt;version&gt;");
    expect(t).not.toContain("<version>");
    expect(t).toContain("1. Traefik: nothing public reaches the forge");
    // No figure that goes stale is written as if current: no disk fill, sizes or counts of the day.
    expect(t).not.toMatch(/% used|\b\d+(\.\d+)? (GB|TB)\b|\b\d+ (single-instance )?databases\b|\b\d+ (local-path )?volumes\b/);
  });
});

describe("ownedBy", () => {
  test("a Deployment's, StatefulSet's and DaemonSet's pods; not a longer workload's", () => {
    expect(ownedBy("cloudflared-6c7b9d8f4-x2x9z", "cloudflared")).toBe(true);
    expect(ownedBy("forgejo-0", "forgejo")).toBe(true);
    expect(ownedBy("traefik-abcde", "traefik")).toBe(true);
    expect(ownedBy("cloudflared-forge-home-5f6d7c8b9-q1w2e", "cloudflared")).toBe(false);
    expect(ownedBy("plat-auth-x", "plat-auth")).toBe(false);
    expect(ownedBy("anything", "*")).toBe(true);
  });
});

describe("probeFooting", () => {
  test("places each piece on the node it runs on; off the forge's node is a risk", async () => {
    const kube = fakeKube();
    const f = await probeFooting({ fetch: kube.fetch, credentials: cred, podName: "forge-7d9f8c6b5-abcde", now: () => new Date("2026-11-12T12:00:00Z") });
    expect(f.forgeNode).toBe("vxrail-1");
    expect(f.unread).toBeNull();
    expect(f.at).toBe("2026-11-12T12:00:00.000Z");
    // The forge's own pod, and the tunnel moved to the vxrail by hand: on the forge's node.
    expect(byId(f, "forge")).toMatchObject({ seen: { by: "cluster", nodes: ["vxrail-1"] }, risk: false });
    expect(byId(f, "tunnel")).toMatchObject({ seen: { by: "cluster", nodes: ["vxrail-1"] }, risk: false });
    expect(byId(f, "tunnel-home")).toMatchObject({ seen: { by: "cluster", nodes: ["vxrail-1"] }, risk: false });
    // The signup gate is looked for in the forge's own namespace (an Ingress routes only within its own).
    expect(byId(f, "signup-gate")).toMatchObject({ seen: { by: "cluster", nodes: ["pg-grand"] }, risk: true });
    // A pod whose namespace is not recorded is not looked for: no list of every pod in the cluster.
    expect(byId(f, "runner")).toMatchObject({ seen: { by: "declared", why: "its namespace is not recorded, and the forge does not list every pod in the cluster" }, risk: false });
    expect(byId(f, "registry-node")).toMatchObject({ seen: { by: "declared" }, risk: false });
    expect(kube.seen).not.toContain("/api/v1/pods");
    expect(kube.seen.every((p) => p === "/api/v1/nodes" || p.startsWith("/api/v1/namespaces/"))).toBe(true);
    // Traefik moved to the forge's node: no longer a risk, whatever the declared list said.
    expect(byId(f, "traefik")).toMatchObject({ seen: { by: "cluster", nodes: ["vxrail-1"] }, risk: false });
    expect(byId(f, "hosts").risk).toBe(false);
    expect(byId(f, "control-plane")).toMatchObject({ seen: { by: "cluster", nodes: ["pg-grand"] }, risk: true });
    // Nothing in the cluster sees a systemd unit: declared, said why, judged by the declared machine.
    expect(byId(f, "release-tick")).toMatchObject({ seen: { by: "declared", why: "forge-release-tick is a systemd unit on a host; the cluster cannot show it" }, risk: true });
    expect(byId(f, "standby-reconcile")).toMatchObject({ seen: { by: "declared" }, risk: true });
    for (const id of ["forge-ssh", "release-tick", "standby-reconcile", "host-timers"]) expect(byId(f, id).seen.by).toBe("declared");
    expect(byId(f, "plat-auth").risk).toBe(true);
    // The backup lane is the forge's own process, and its bucket is on neither machine (#11805).
    expect(byId(f, "backup-lane")).toMatchObject({ seen: { by: "cluster", nodes: ["vxrail-1"] }, risk: false });
    expect(byId(f, "offsite-bucket")).toMatchObject({ machine: "off-site", seen: { by: "declared" }, risk: false });
    // Neither the platform's backup namespace nor MinIO is asked for any more.
    expect(kube.seen.some((p) => p.includes("/namespaces/backup/") || p.includes("/namespaces/minio/"))).toBe(false);
    // Each namespace is listed once although two pieces live in forgejo.
    expect(kube.seen.filter((p) => p === "/api/v1/namespaces/forgejo/pods").length).toBe(1);
    const off = ["forge-ssh", "control-plane", "plat-auth", "signup-gate", "forgejo", "cnpg", "registry", "release-tick", "standby-reconcile", "host-timers"];
    expect(f.rows.filter((r) => r.risk).map((r) => r.id).sort()).toEqual([...off].sort());
    // In the order pg-grand switched off would break the forge: sign-in first, host timers last.
    const lines = riskLines(f);
    expect(lines.length).toBe(off.length);
    expect(lines[0]).toStartWith("sign-in: Sign-in edge");
    expect(lines[0]).toContain(" on pg-grand. Every request through the edge answers 500, /healthz too.");
    expect(lines[1]).toStartWith("sign-in: forge-signup-gate");
    expect(lines.at(-1)).toStartWith("release: Host timers forge-watchdog");
  });

  test("with every piece on the forge's node, there is no risk line", async () => {
    const everyone = (names: string[]) => ({ items: names.map((n) => pod(n, "pg-grand")) });
    const kube = fakeKube({
      "/api/v1/namespaces/forge/pods/forge-7d9f8c6b5-abcde": { spec: { nodeName: "pg-grand" } },
      "/api/v1/namespaces/standby/pods": everyone(["cloudflared-6c7b9d8f4-x2x9z", "cloudflared-forge-home-5f6d7c8b9-q1w2e"]),
      "/api/v1/namespaces/forge/pods": everyone(["forge-signup-gate-6d5c4b3a2-sgate"]),
      "/api/v1/namespaces/minio/pods": everyone(["minio-0"]),
      "/api/v1/namespaces/backup/pods": everyone(["lane-forge-29000000-abcde"]),
      "/api/v1/namespaces/kube-system/pods": everyone(["traefik-5b8d9c7f6-zzzzz"]),
    });
    // Every piece the cluster can show is on the forge's node; the host units are declared on pg-grand, so they remain.
    const f = await probeFooting({ fetch: kube.fetch, credentials: cred, podName: "forge-7d9f8c6b5-abcde" });
    expect(f.rows.filter((r) => r.risk).map((r) => r.id).sort()).toEqual(["forge-ssh", "host-timers", "release-tick", "standby-reconcile"]);
    expect(f.rows.filter((r) => r.risk).every((r) => r.seen.by === "declared")).toBe(true);
  });

  test("the forge's own namespace refused: the signup gate keeps its declared machine and says why", async () => {
    const kube = fakeKube({ "/api/v1/namespaces/forge/pods": 403 });
    const f = await probeFooting({ fetch: kube.fetch, credentials: cred, podName: "forge-7d9f8c6b5-abcde" });
    expect(byId(f, "signup-gate")).toMatchObject({ seen: { by: "declared", why: "the forge's service account may not read pods in forge" }, risk: true });
  });

  test("outside a cluster: the declared list, said so, every pg-grand row a risk", async () => {
    let fetched = 0;
    const f = await probeFooting({
      podName: "x",
      credentials: () => {
        throw new Error("not running in a cluster");
      },
      fetch: async () => {
        fetched++;
        return Response.json({});
      },
    });
    expect(fetched).toBe(0);
    expect(f.forgeNode).toBeNull();
    expect(f.unread).toBe("not read: not running in a cluster");
    expect(f.rows.every((r) => r.seen.by === "declared" && r.risk === (r.machine === "pg-grand"))).toBe(true);
  });

  test("the forge's own pod unreadable: its node is unknown and the declared machines decide risk", async () => {
    const kube = fakeKube({ "/api/v1/namespaces/forge/pods/forge-7d9f8c6b5-abcde": 403 });
    const f = await probeFooting({ fetch: kube.fetch, credentials: cred, podName: "forge-7d9f8c6b5-abcde" });
    expect(f.forgeNode).toBeNull();
    expect(f.unread).toBe("the forge's service account may not read its own pod");
    expect(byId(f, "traefik").risk).toBe(true);
    expect(byId(f, "forge")).toMatchObject({ seen: { by: "declared", why: "the forge's service account may not read its own pod" }, risk: false });
  });
});

describe("footingCache", () => {
  test("a slow cluster gives the declared list at once, and the reading once it lands", async () => {
    let release!: (f: Footing) => void;
    const live = declaredFooting("live", new Date(0));
    let calls = 0;
    const cache = footingCache(() => {
      calls++;
      return new Promise<Footing>((r) => (release = r));
    });
    expect(cache.peek()).toBeNull();
    const first = await cache.read(5);
    expect(first.unread).toBe("the cluster did not answer in time; reload in a moment");
    expect(calls).toBe(1); // peek's refresh is the one read waited on
    release(live);
    await Bun.sleep(0);
    expect(cache.peek()).toBe(live);
    expect(await cache.read(5)).toBe(live);
    expect(calls).toBe(1);
  });

  test("a probe that throws is not retried for 60 s, by peek or by read", async () => {
    let now = 1_000_000;
    let calls = 0;
    const cache = footingCache(async () => {
      calls++;
      throw new Error("kube down");
    }, () => now);
    expect(cache.peek()).toBeNull();
    await Bun.sleep(0);
    expect(calls).toBe(1);
    now += 30_000;
    expect(cache.peek()).toBeNull();
    expect((await cache.read(5)).unread).toBe("the cluster did not answer; it is asked again within a minute");
    await Bun.sleep(0);
    expect(calls).toBe(1);
    now += 30_001;
    cache.peek();
    await Bun.sleep(0);
    expect(calls).toBe(2);
  });

  test("a fast read leaves no deadline timer behind", async () => {
    const live = declaredFooting("live", new Date(0));
    const cleared: unknown[] = [];
    const real = globalThis.clearTimeout;
    globalThis.clearTimeout = ((t: Parameters<typeof clearTimeout>[0]) => {
      cleared.push(t);
      real(t);
    }) as typeof clearTimeout;
    try {
      expect(await footingCache(async () => live).read(60_000)).toBe(live);
    } finally {
      globalThis.clearTimeout = real;
    }
    expect(cleared.length).toBe(1);
    expect(cleared[0]).toBeDefined();
  });
});

describe("where it shows", () => {
  let dir = "";
  let app: App;
  let servers: Servers;
  const tok: Record<string, string> = {};
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-footing-"));
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    for (const [username, first] of [["alice", true], ["bob", false]] as const) {
      const r = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: "a-good-passphrase", ...(first ? { adminIfFirst: true } : {}) });
      if (!r.ok) throw new Error(r.error);
      tok[username] = createToken(app.db, r.value.id, "t", "admin").token;
    }
  }, 30_000);
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the section has one heading, says the count once, and a row of facts per piece off the forge's machine, escaped", async () => {
    const kube = fakeKube();
    const f = await probeFooting({ fetch: kube.fetch, credentials: cred, podName: "forge-7d9f8c6b5-abcde" });
    const out = String(footingSection(f));
    const off = f.rows.filter((r) => r.risk).length;
    expect(out.match(/<h2>What the forge stands on<\/h2>/g)?.length).toBe(1);
    expect(out).toContain(`data-off="${off}"`);
    expect(out.match(new RegExp(`${off} of ${f.rows.length}`, "g"))?.length).toBe(1);
    expect(out).toContain('data-piece="traefik" data-off="false"');
    expect(out).toMatch(/data-piece="plat-auth" data-off="true"/);
    expect(out).toContain('data-breaks="2"');
    // Off-machine rows come in break order, each fact its own dt/dd.
    const order = [...out.matchAll(/data-piece="([a-z-]+)" data-off="true"/g)].map((m) => m[1]);
    expect(order.slice(0, 2)).toEqual(["plat-auth", "signup-gate"]);
    expect(out).toContain("<dt>If it stops</dt>");
    // Plain words, one colour: no badge, and neither "risk" nor "footing" on the page.
    expect(out).not.toContain("badge");
    expect(out.replace(/<[^>]*>/g, "")).not.toMatch(/\brisk|footing/i);
    expect(out).toContain('data-machine="pg-grand"');
    expect(out).toContain("forge:&lt;version&gt;");
    expect(out).toContain("The forge runs on <span class=\"mono\">vxrail-1</span>.");
    const hostile = { ...f, forgeNode: "<img src=x>" };
    expect(String(footingSection(hostile))).not.toContain("<img src=x>");
  });

  test("the owner's /system shows it", async () => {
    const res = await fetch(`${servers.url}/system`, { headers: { authorization: `Bearer ${tok["alice"]}` } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<h2>What the forge stands on</h2>");
    expect(body).toContain('id="sys-footing"');
  });

  test("/system keeps the rows behind one closed disclosure and never waits on the cluster", async () => {
    const t0 = performance.now();
    const res = await fetch(`${servers.url}/system`, { headers: { authorization: `Bearer ${tok["alice"]}` } });
    const body = await res.text();
    expect(performance.now() - t0).toBeLessThan(800);
    const section = body.slice(body.indexOf('id="sys-footing"'), body.indexOf("</section>", body.indexOf('id="sys-footing"')));
    expect(section).toMatch(/<details id="sys-footing-more" class="disclosure">/);
    expect(section).not.toMatch(/<details[^>]*\bopen\b/);
    expect(section.slice(section.indexOf("<details")).match(/data-piece=/g)?.length).toBe(FOOTING.length);
  });

  const identity = (user?: User) => ({ sshUsername: user?.username ?? "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user });

  test("the terminal screen gives an admin the rows off the forge's machine in break order, with node and if-dies", async () => {
    const f = await probeFooting({ fetch: fakeKube().fetch, credentials: cred, podName: "forge-7d9f8c6b5-abcde" });
    const lines = footingLines(new Session(app, identity(getUserByName(app.db, "alice")!)), f);
    expect(lines[0]).toBe("The forge runs on vxrail-1.");
    const off = f.rows.filter((r) => r.risk);
    expect(lines).toContain(`${off.length} of ${f.rows.length} pieces run on another machine. With pg-grand off, they fail in this order:`);
    const steps = lines.filter((l) => /^ {0,2}\d+ {2}(answer|sign-in|build|release|backup)\b/.test(l));
    expect(steps.length).toBe(off.length);
    expect(steps[0]).toMatch(/^ {2}2 {2}sign-in\s+Sign-in edge/);
    expect(steps.map((l) => Number(l.trim().split(/\s+/)[0]))).toEqual([...steps.map((l) => Number(l.trim().split(/\s+/)[0]))].sort((a, b) => a - b));
    expect(lines).toContain(`${" ".repeat(15)}if it dies: Every request through the edge answers 500, /healthz too.`);
    expect(lines).toContain(`${" ".repeat(15)}on pg-grand (declared: forge-release-tick is a systemd unit on a host; the cluster cannot show it)`);
    expect(lines.at(-1)).toStartWith("On the forge's own machine: forge, tunnel, tunnel-home, traefik, hosts");
  });

  test("a guest, a signed-in non-admin and nobody get no lines and no door", () => {
    const f = declaredFooting("x");
    const doors = (user?: User): string[] => {
      const { app: tui, session } = createForgeApp(app, identity(user), { terminal: headlessTerminal(80, 24), exitHooks: false });
      const ids = forgeCommands(session)(tui.ctx).map((c) => c.id);
      tui.stop?.();
      return ids;
    };
    const alice = getUserByName(app.db, "alice")!;
    expect(doors(alice)).toContain("footing");
    for (const who of [getUserByName(app.db, "bob")!, undefined]) {
      expect(footingLines(new Session(app, identity(who)), f)).toEqual([]);
      expect(doors(who)).not.toContain("footing");
    }
  });

  test("the screen draws for an admin without waiting on the cluster", async () => {
    const { app: tui, session } = createForgeApp(app, identity(getUserByName(app.db, "alice")!), { terminal: headlessTerminal(120, 50), exitHooks: false });
    tui.start();
    tui.ctx.push(footingScreen(session, tui.ctx));
    await settleApp(tui);
    const text = tui.screen.toText();
    expect(text).toContain("What the forge stands on");
    expect(text).toContain("pieces run on another machine");
    tui.stop?.();
  });

  const mcp = async (who: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok[who]}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "system", arguments: { kind: "footing" } } }),
    });
    return (await res.json()) as any;
  };

  test("the MCP system tool answers it to an admin, with the risk lines, and refuses anyone else", async () => {
    const out = JSON.parse((await mcp("alice")).result.content[0].text);
    expect(out.rows.map((r: { id: string }) => r.id)).toEqual(FOOTING.map((p) => p.id));
    expect(Array.isArray(out.risks)).toBe(true);
    expect(out.risks.length).toBe(out.rows.filter((r: { risk: boolean }) => r.risk).length);
    const refused = await mcp("bob");
    expect(JSON.stringify(refused)).toContain("only an admin of this forge reads what it stands on");
  });
});
