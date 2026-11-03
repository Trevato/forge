/**
 * Live machine telemetry and its open read hooks (#1789): /proc and /sys
 * read into one view; the same test file in two checks counted as duplicate
 * work; /system and /flow read by the owner and by an agent holding
 * `telemetry:read` — with private repositories cut out — and refused to an
 * agent without it; the grant is the owner's alone and every agent read is
 * logged; the funnel is open to all.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createRepo } from "../src/actions/repos.ts";
import { setTelemetryGrant } from "../src/actions/telemetry.ts";
import { recentReads } from "../src/core/telemetry.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { parseCores, parseNet, testFiles } from "../src/system/proc.ts";
import { createLive, live, useLive } from "../src/system/live.ts";
import type { Ctx, Screen } from "../src/tui/app/app.ts";
import { forgeCommands, Session } from "../src/tui/forge.ts";
import { systemLines } from "../src/tui/screens/system.ts";
import { flowLines } from "../src/tui/screens/flow.ts";
import { hasGrant, logRead } from "../src/core/telemetry.ts";

const stat = (pid: number, comm: string, ppid: number, ticks: number): string => {
  const f: (number | string)[] = new Array<number>(40).fill(0);
  f[0] = "S";
  f[1] = ppid;
  f[11] = ticks;
  f[19] = 100;
  f[21] = 256;
  return `${pid} (${comm}) ${f.join(" ")}`;
};

function fakeHost(root: string, ticks: number): void {
  const proc = join(root, "proc");
  mkdirSync(join(proc, "net"), { recursive: true });
  mkdirSync(join(root, "sys/class/hwmon/hwmon0"), { recursive: true });
  writeFileSync(join(root, "sys/class/hwmon/hwmon0/name"), "coretemp\n");
  writeFileSync(join(root, "sys/class/hwmon/hwmon0/temp1_input"), "76000\n");
  writeFileSync(join(root, "sys/class/hwmon/hwmon0/temp1_label"), "Core 0\n");
  writeFileSync(
    join(proc, "stat"),
    `cpu  ${ticks} 0 0 100 0 0 0 0\ncpu0 ${ticks} 0 0 100 0 0 0 0\ncpu1 0 0 0 ${ticks} 0 0 0 0\n`,
  );
  writeFileSync(join(proc, "meminfo"), "MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n");
  writeFileSync(join(proc, "loadavg"), "64.00 60.00 50.00 3/3071 999\n");
  writeFileSync(join(proc, "uptime"), "5000.00 100.00\n");
  writeFileSync(join(proc, "mounts"), "");
  writeFileSync(
    join(proc, "net/dev"),
    "Inter-|   Receive\n face |bytes\n  lo: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0\n eth0: ${r} 0 0 0 0 0 0 0 ${t} 0 0 0 0 0 0 0\n"
      .replace("${r}", String(ticks * 10))
      .replace("${t}", String(ticks * 5)),
  );
  const proc1 = (pid: number, comm: string, ppid: number, args: string) => {
    mkdirSync(join(proc, String(pid)), { recursive: true });
    writeFileSync(join(proc, String(pid), "stat"), stat(pid, comm, ppid, ticks));
    writeFileSync(join(proc, String(pid), "cmdline"), args);
  };
  proc1(1, "forge", 0, "bun\0src/main.ts\0");
  proc1(200, "bwrap", 1, "bwrap\0");
  proc1(201, "bun", 200, "bun\0test\0test/shared.test.ts\0--secret-flag=hunter2\0");
  proc1(300, "bwrap", 1, "bwrap\0");
  proc1(301, "bun", 300, "bun\0test\0./test/shared.test.ts\0");
  proc1(400, "bwrap", 1, "bwrap\0");
  proc1(401, "bun", 400, "bun\0test\0test/alone.test.ts\0");
  proc1(500, "bun", 1, "bun\0test\0test/private-thing.test.ts\0");
}

describe("the machine, read from /proc and /sys", () => {
  test("per-core ticks, interfaces and test-file arguments — nothing else of a command line", () => {
    expect(parseCores("cpu  9 0 0 1\ncpu0 3 0 0 1 0 0 0 0\ncpu1 1 0 0 3 0 0 0 0\n")).toEqual([
      { busy: 3, total: 4 },
      { busy: 1, total: 4 },
    ]);
    expect(parseNet("h\nh\n  lo: 5 0 0 0 0 0 0 0 5\neth0: 7 0 0 0 0 0 0 0 9\n")).toEqual([{ name: "eth0", rx: 7, tx: 9 }]);
    expect(testFiles("bun\0test\0./test/a.test.ts\0--token=abc\0../etc/x\0$(id).test.ts\0")).toEqual(["test/a.test.ts"]);
  });

  test("two checks running one test file are duplicate work, grouped by what launched them", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-sys-"));
    try {
      fakeHost(root, 100);
      const roots = [
        { label: "check:RUN1", root: 200 },
        { label: "check:RUN2", root: 300 },
        { label: "check:RUN3", root: 400 },
      ];
      const l = createLive({ paths: { proc: join(root, "proc"), sys: join(root, "sys") }, roots: () => roots, self: 1 });
      const v = l.read(1_000_000);
      expect(v.duplicates).toEqual([{ file: "test/shared.test.ts", checks: ["check:RUN1", "check:RUN2"] }]);
      expect(v.groups.find((g) => g.label === "check:RUN1")?.procs).toBe(2);
      expect(v.groups.find((g) => g.label === "forge")?.procs).toBe(2);
      expect(v.cpu.cores.length).toBe(2);
      expect(v.hottestC).toBe(76);
      expect(v.load?.[0]).toBe(64);
      expect(v.memory).toEqual({ totalBytes: 1024_000, usedBytes: 614_400, swapUsedBytes: 0, swapTotalBytes: 0 });
      expect(JSON.stringify(v)).not.toContain("hunter2");
      // A later reading gives rates over the two latest.
      fakeHost(root, 300);
      const w = l.read(1_002_000);
      expect(w.seconds).toBeCloseTo(2, 5);
      expect(v.seconds).toBe(0);
      expect(v.net[0]?.rxBytesPerSecond).toBeNull();
      expect(w.net[0]?.rxBytesPerSecond).toBeCloseTo(2000 / 2, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("telemetry:read: the owner grants it, an agent reads with it, nobody else does", () => {
  let dataDir: string;
  let host: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let muse: User;
  let grok: User;
  let tokens: Record<string, string>;

  const get = (token: string | undefined, path: string) =>
    fetch(`${servers.url}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const login = async (username: string): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const tool = async (token: string, name: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
    });
    const b = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    return { error: b.result.isError === true, text: b.result.content[0]!.text };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-telemetry-"));
    host = mkdtempSync(join(tmpdir(), "forge-host-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, adminIfFirst = false) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    alice = await mk("alice", true);
    bob = await mk("bob");
    const agent = async (username: string) => {
      const made = await createAgent(app, alice, { username });
      if (!made.ok) throw new Error(String(made.error));
      return made.value.user;
    };
    muse = await agent("muse");
    grok = await agent("grokbot");
    const priv = await createRepo(app, alice, { name: "vault-of-secrets", visibility: "private" });
    const pub = await createRepo(app, alice, { name: "open-garden", visibility: "public" });
    if (!priv.ok || !pub.ok) throw new Error("repos");
    for (const [id, repo] of [["RUN1", priv.value], ["RUN2", pub.value], ["RUN3", pub.value]] as const)
      app.db
        .query("INSERT INTO run (id, repo_id, kind, state) VALUES (?1, ?2, 'deploy', 'running')")
        .run(id, repo.id);
    // One pull in conflict in each repository: only the public one may reach an agent.
    for (const [n, repo] of [[1, priv.value], [2, pub.value]] as const) {
      const id = `PULL${n}`;
      app.db
        .query("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES (?1, ?2, ?3, 'pull', 'p', ?4)")
        .run(id, repo.id, n, alice.id);
      app.db
        .query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?1, 'main', 'f', 'a', 'b')")
        .run(id);
      app.db
        .query("INSERT INTO run (id, repo_id, kind, issue_id, reason, state) VALUES (?1, ?2, 'agent', ?3, 'conflict', 'queued')")
        .run(`CONF${n}`, repo.id, id);
    }
    fakeHost(host, 100);
    useLive(
      createLive({
        paths: { proc: join(host, "proc"), sys: join(host, "sys") },
        roots: () => [
          { label: "check:RUN1", root: 200, cap: { bytes: 8192 * 2 ** 20, by: "kernel" } },
          { label: "check:RUN2", root: 300 },
          { label: "check:RUN3", root: 400 },
        ],
        self: 1,
      }),
    );
    tokens = {
      alice: createToken(app.db, alice.id, "t", "admin").token,
      bob: createToken(app.db, bob.id, "t", "rw").token,
      muse: createToken(app.db, muse.id, "t", "ro").token,
      grok: createToken(app.db, grok.id, "t", "ro").token,
    };
    expect(setTelemetryGrant(app, alice, "muse", true).ok).toBe(true);
  });

  afterAll(async () => {
    useLive(createLive());
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    rmSync(host, { recursive: true, force: true });
  });

  test("an agent without the grant, a member and nobody are refused", async () => {
    for (const path of ["/api/v1/telemetry/system", "/api/v1/telemetry/flow", "/api/v1/telemetry/sources"]) {
      expect((await get(tokens["grok"], path)).status).toBe(403);
      expect((await get(tokens["bob"], path)).status).toBe(403);
      expect((await get(undefined, path)).status).toBe(401);
    }
    expect((await tool(tokens["grok"]!, "system")).error).toBe(true);
    expect((await tool(tokens["grok"]!, "flow")).error).toBe(true);
    const bobCookie = await login("bob");
    expect((await fetch(`${servers.url}/system`, { headers: { cookie: bobCookie } })).status).toBe(404);
    const bobPage = await fetch(`${servers.url}/system`, { headers: { cookie: bobCookie } });
    expect(await bobPage.text()).not.toContain("Telemetry readers");
  });

  test("a granted agent reads /system and /flow, with private repositories cut out", async () => {
    const sys = await get(tokens["muse"], "/api/v1/telemetry/system");
    expect(sys.status).toBe(200);
    const text = await sys.text();
    expect(text).not.toContain("RUN1");
    expect(text).not.toContain("hunter2");
    // A test outside any cell lands in `forge`; its file name is not an agent's to read.
    expect(text).not.toContain("private-thing");
    const v = JSON.parse(text) as { groups: { label: string; kind: string; top: unknown[]; procs: number }[]; duplicates: { file: string; checks: string[] }[] };
    const hidden = v.groups.find((g) => g.label === "check:private-1");
    expect(hidden?.procs).toBe(2);
    expect(hidden?.top).toEqual([]);
    expect(v.groups.some((g) => g.label === "check:RUN2")).toBe(true);
    expect(v.duplicates).toEqual([{ file: "(private)", checks: ["check:RUN2", "check:private-1"] }]);

    const flow = await get(tokens["muse"], "/api/v1/telemetry/flow");
    expect(flow.status).toBe(200);
    const f = (await flow.json()) as { says: string; stages: unknown[]; duplicateWork: unknown[] };
    expect(f.stages.length).toBeGreaterThan(0);
    expect(f.duplicateWork.length).toBe(1);
    // A conflicted private pull is not named to an agent, in the list or in the sentence.
    const flowText = JSON.stringify(f);
    expect(flowText).toContain("alice/open-garden#2");
    expect(flowText).not.toContain("vault-of-secrets");
    const viaMcp = await tool(tokens["muse"]!, "flow");
    expect(viaMcp.text).toContain("alice/open-garden#2");
    expect(viaMcp.text).not.toContain("vault-of-secrets");
    const history = await get(tokens["muse"], "/api/v1/telemetry/history");
    expect(history.status).toBe(200);
    expect(Array.isArray(((await history.json()) as { points: unknown[] }).points)).toBe(true);
    expect((await get(tokens["grok"], "/api/v1/telemetry/history")).status).toBe(403);
    const sources = (await (await get(tokens["muse"], "/api/v1/telemetry/sources")).json()) as { sources: { name: string }[] };
    expect(sources.sources.map((s) => s.name)).toContain("machine");
    expect((await tool(tokens["muse"]!, "system")).error).toBe(false);
    expect((await tool(tokens["muse"]!, "flow")).error).toBe(false);
  });

  test("a private repository's merge-queue line reaches the owner, never an agent", async () => {
    const priv = app.db
      .query<{ id: string }, []>("SELECT id FROM repo WHERE name = 'vault-of-secrets'")
      .get()!;
    app.db
      .query("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES ('PULLQ', ?1, 9, 'pull', 'q', ?2)")
      .run(priv.id, alice.id);
    app.db
      .query(
        "INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) SELECT 'PULLQ', default_branch, 'q', 'a', 'b', strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM repo WHERE id = ?1",
      )
      .run(priv.id);
    type Flow = { queue: { repo: string }[] };
    const names = (f: Flow) => f.queue.map((q) => q.repo);
    const mcp = async (t: string) => JSON.parse((await tool(t, "flow")).text) as Flow;
    const api = async (t: string) => (await (await get(t, "/api/v1/telemetry/flow")).json()) as Flow;

    expect(names(await api(tokens["alice"]!))).toContain("alice/vault-of-secrets");
    expect(names(await mcp(tokens["alice"]!))).toContain("alice/vault-of-secrets");
    expect(names(await api(tokens["muse"]!))).not.toContain("alice/vault-of-secrets");
    expect(names(await mcp(tokens["muse"]!))).not.toContain("alice/vault-of-secrets");
  });

  test("the owner sees everything; every agent read is logged; revoking closes the door", async () => {
    expect(await (await get(tokens["alice"], "/api/v1/telemetry/flow")).text()).toContain("vault-of-secrets");
    expect(await (await get(tokens["alice"], "/api/v1/telemetry/system")).text()).toContain("private-thing");
    const own = await (await get(tokens["alice"], "/api/v1/telemetry/system")).text();
    expect(own).toContain("check:RUN1");
    const page = await fetch(`${servers.url}/system`, { headers: { cookie: await login("alice") } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Telemetry readers");
    expect(html).toContain('id="duplicates" data-count="1"');
    expect(html).toContain("test/shared.test.ts");
    // Each check cell's memory beside its cap, and who holds the cap (#2410).
    expect(html).toContain('data-cap="8589934592" data-cap-by="kernel">of 8.0 GiB (kernel cap)');
    expect(html).toMatch(/id="cell-caps" data-by="(kernel|watch)"/);
    // Built from the system's own parts: pills, meters and the process table grouped by kind (#2721), no style attribute (#2691).
    expect(html).toMatch(/id="summary"[^>]*>\s*<span class="pill"/);
    expect(html).toContain('<tbody data-kind="check"');
    expect(html).not.toMatch(/<[a-z]+ [^>]*\bstyle="/);
    const flowPage = await fetch(`${servers.url}/boards`, { headers: { cookie: await login("alice") } });
    expect(await flowPage.text()).toContain('id="duplicate-work" data-count="1"');

    const reads = recentReads(app.db).filter((r) => r.username === "muse");
    expect(reads.map((r) => r.what)).toContain("system");
    expect(reads.map((r) => r.what)).toContain("flow");
    expect(recentReads(app.db).some((r) => r.username === "alice")).toBe(false);

    // The grant is the owner's alone — not an agent's own, not a member's.
    expect(setTelemetryGrant(app, muse, "grokbot", true)).toEqual({ ok: false, error: "not_found" });
    expect(setTelemetryGrant(app, bob, "grokbot", true)).toEqual({ ok: false, error: "not_found" });
    expect(setTelemetryGrant(app, alice, "bob", true)).toEqual({ ok: false, error: "not_an_agent" });

    const cookie = await login("alice");
    const revoke = await fetch(`${servers.url}/settings/telemetry`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ agent: "muse", on: "0" }),
    });
    expect(revoke.status).toBe(303);
    expect((await get(tokens["muse"], "/api/v1/telemetry/system")).status).toBe(403);
    // A cross-origin grant is refused.
    const forged = await fetch(`${servers.url}/settings/telemetry`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: new URLSearchParams({ agent: "grokbot", on: "1" }),
    });
    expect(forged.status).not.toBe(303);
    expect((await get(tokens["grok"], "/api/v1/telemetry/system")).status).toBe(403);
    const settings = await fetch(`${servers.url}/settings/telemetry`, { headers: { cookie } });
    expect(settings.status).toBe(200);
  });

  test("the funnel is open to anyone and names the bottleneck, the welcoming issues and the gate", async () => {
    const res = await get(undefined, "/api/v1/contribute");
    expect(res.status).toBe(200);
    const w = (await res.json()) as { bottleneck: { says: string; see: string }; telemetry: string; propose: string[]; issues: unknown[] };
    expect(w.bottleneck.says.length).toBeGreaterThan(0);
    expect(w.bottleneck.see).toContain("/api/v1/telemetry/flow");
    expect(w.bottleneck.see.startsWith("/flow")).toBe(false);
    expect(w.telemetry).not.toContain("read /flow");
    expect(w.propose.join(" ")).toContain("bun test");
    const html = await (await get(undefined, "/contribute")).text();
    expect(html).toContain("How to propose");
    expect((await tool(tokens["grok"]!, "contribute")).error).toBe(false);
  });

  test("a sealed security report labelled help wanted is never offered to a visitor", async () => {
    const repo = app.db.query<{ id: string }, []>("SELECT id FROM repo WHERE name = 'open-garden'").get()!;
    app.db
      .query("INSERT INTO issue (id, repo_id, number, kind, title, author_id, sealed) VALUES ('SEALED1', ?1, 77, 'issue', 'overflow in the zebra parser', ?2, 1)")
      .run(repo.id, alice.id);
    app.db.query("INSERT INTO label (id, repo_id, name) VALUES ('LBLHW', ?1, 'help wanted')").run(repo.id);
    app.db.query("INSERT INTO issue_label (issue_id, label_id) VALUES ('SEALED1', 'LBLHW')").run();
    app.db
      .query("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES ('OPEN1', ?1, 78, 'issue', 'tidy the herbs', ?2)")
      .run(repo.id, alice.id);
    app.db.query("INSERT INTO issue_label (issue_id, label_id) VALUES ('OPEN1', 'LBLHW')").run();
    const api = await (await get(undefined, "/api/v1/contribute")).text();
    const page = await (await get(undefined, "/contribute")).text();
    const mcp = (await tool(tokens["grok"]!, "contribute")).text;
    for (const out of [api, page, mcp]) {
      expect(out).toContain("tidy the herbs");
      expect(out).not.toContain("zebra");
    }
  });

  test("an admin agent reads flow only with the grant, in the page and the terminal, and sees the agent view", async () => {
    const made = await createAgent(app, alice, { username: "zadminbot" });
    if (!made.ok) throw new Error(String(made.error));
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(made.value.user.id);
    const adminbot = getUserByName(app.db, "zadminbot")!;
    expect(adminbot.isAdmin).toBe(true);
    createToken(app.db, adminbot.id, "t", "admin");
    const flowCommand = () => {
      const ctx = { push: () => {}, pop: () => {}, toast: () => {} } as unknown as Ctx;
      const session = new Session(app, { sshUsername: "zadminbot", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: adminbot });
      return forgeCommands(session)(ctx).find((c) => c.id === "flow");
    };
    expect(flowCommand()).toBeUndefined();

    expect(setTelemetryGrant(app, alice, "zadminbot", true).ok).toBe(true);
    const flow = flowCommand();
    expect(flow).toBeDefined();
    flow!.run?.();
    expect(recentReads(app.db).some((r) => r.username === "zadminbot" && r.what === "flow")).toBe(true);
    // Revoked, the door closes again.
    setTelemetryGrant(app, alice, "zadminbot", false);
    expect(flowCommand()).toBeUndefined();
  });

  test("GET /flow is the pipes page, no longer a redirect to /boards", async () => {
    const res = await fetch(`${servers.url}/flow`, { redirect: "manual", headers: { authorization: `Bearer ${tokens["alice"]}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  test("in the terminal, the owner is offered System and Telemetry; nobody else is", () => {
    const run = (user: User, id: string) => {
      const pushed: Screen[] = [];
      const toasts: string[] = [];
      const ctx = { push: (x: Screen) => pushed.push(x), pop: () => {}, toast: (t: string) => toasts.push(t) } as unknown as Ctx;
      const session = new Session(app, { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user });
      return { cmd: forgeCommands(session)(ctx).find((c) => c.id === id), pushed, toasts };
    };
    for (const u of [bob, muse]) {
      expect(run(u, "system").cmd).toBeUndefined();
      expect(run(u, "telemetry").cmd).toBeUndefined();
    }
    const sys = run(alice, "system");
    sys.cmd!.run();
    expect(sys.pushed.map((x) => x.title)).toEqual(["System"]);
    const lines = systemLines(JSON.parse(JSON.stringify(live().read())));
    expect(lines.join("\n")).toContain("1 test file is running in more than one check");
    // A check cell's memory beside its cap and who holds it, as /system says it (#2410).
    expect(lines.find((l) => l.startsWith("check:RUN1"))).toMatch(/procs {2}\S+ \S+ of 8\.0 GiB kernel$/);
    expect(lines.every((l) => l.length <= 66)).toBe(true);

    expect(flowLines(app.db, new Date(), JSON.parse(JSON.stringify(live().read().duplicates))).join("\n")).toContain(
      "1 test file is running in more than one check",
    );
    expect(flowLines(app.db, new Date(), []).join("\n")).toContain("No test file is running in more than one check.");

    logRead(app.db, grok.id, "system");
    const tel = run(alice, "telemetry");
    tel.cmd!.run();
    expect(tel.pushed.map((x) => x.title)).toEqual(["Telemetry: telemetry:read"]);
    expect(hasGrant(app.db, grok.id)).toBe(false);
    // Enter on the list's first row (grokbot, alphabetically before muse) flips its grant.
    tel.pushed[0]!.key({ key: "enter" } as never);
    expect(hasGrant(app.db, grok.id)).toBe(true);
    expect(tel.toasts.join()).toContain("granted");
  });
});
