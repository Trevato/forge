/** The real hands of a pack deploy: no credential leaves for a stranger's host, 409 alone means "exists", the terminal screen. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { packNamed } from "../src/packs/catalog.ts";
import { deployCommands } from "../src/packs/words.ts";
import { createForgeApp, forgeCommands } from "../src/tui/forge.ts";
import { packLines, packsScreen } from "../src/tui/screens/packs.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { cloneEnv, pushEnv, realHands } from "../scripts/pack.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("git credentials", () => {
  test("the clone env carries no Authorization and no extra header", () => {
    const env = cloneEnv();
    expect(Object.entries(env).some(([k, v]) => /authorization|extraheader/i.test(k + v))).toBe(false);
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
  });
  test("the push env scopes the header to the forge's own address", () => {
    const env = pushEnv("https://forge.example/", "tok");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://forge.example/.extraHeader");
    expect(env.GIT_CONFIG_VALUE_0).toContain("Authorization: Basic ");
  });
  test("cloning a source sends the source host nothing but git's own asks", async () => {
    const seen: (string | null)[] = [];
    const stranger = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(req.headers.get("authorization"));
        return new Response("no", { status: 404 });
      },
    });
    try {
      const r = await realHands("http://127.0.0.1:1", "secret-token").carryHistory(`http://127.0.0.1:${stranger.port}/x.git`, "o", "n", undefined);
      expect(r.ok).toBe(false);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((h) => h === null)).toBe(true);
    } finally {
      await stranger.stop(true);
    }
  });
});

describe("makeAgent", () => {
  const answering = (status: number) => Bun.serve({ port: 0, fetch: () => new Response("{}", { status }) });
  const member = { username: "helper", roles: ["builder" as const], brief: "Help." };
  test("only 409 means the crew member exists", async () => {
    for (const [status, exists] of [[409, true], [422, false], [500, false]] as const) {
      const s = answering(status);
      try {
        const r = await realHands(`http://127.0.0.1:${s.port}`, "t").makeAgent(member);
        expect(r.ok).toBe(false);
        if (!r.ok) expect([status, r.exists]).toEqual([status, exists]);
      } finally {
        await s.stop(true);
      }
    }
  });
});

describe("deploy words", () => {
  const games = packNamed("games")!;
  test("the clone source is the configured address, never a request's Host", () => {
    expect(deployCommands(games, "https://f.example/")[0]).toContain("git clone https://f.example/trevato/forge.git");
    expect(deployCommands(games, undefined)[0]).not.toContain("http");
  });
  test("the web page does not echo a forged Host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "packs-host-"));
    const a = createApp({ dataDir: dir, port: 0 });
    const servers = await serve(a);
    try {
      const res = await fetch(`${servers.url}/packs/games`, { headers: { host: "evil.example" } });
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain("git clone http://evil.example");
    } finally {
      await servers.stop();
      a.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("terminal screen", () => {
  let dir: string;
  let app: App;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "packs-tui-"));
    app = createApp({ dataDir: dir, port: 0 });
    const r = await createUser(app.db, { origin: "seed", trusted: true, username: "carol", email: "c@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!r.ok) throw new Error(r.error);
  });
  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const open = () => createForgeApp(app, { sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t" }, { terminal: headlessTerminal(120, 40), exitHooks: false });

  test("a stranger is offered it in the palette", () => {
    const { app: tui, session } = open();
    expect(forgeCommands(session)(tui.ctx).map((c) => c.id)).toContain("packs");
    tui.stop?.();
  });
  test("it lists the packs, opens one, and says the deploy command and what happens to a pull", async () => {
    const { app: tui } = open();
    tui.start();
    tui.ctx.push(packsScreen(tui.ctx, undefined));
    await settleApp(tui);
    const list = tui.screen.toText();
    expect(list).toContain("Games");
    expect(list).toContain("Business");
    tui.ctx.pop();
    const lines = packLines(packNamed("games")!, undefined).join("\n");
    expect(lines).toContain("scripts/pack.ts deploy games");
    expect(lines).toContain("scripts/pack.ts up games");
    expect(lines).toContain("waits for a person");
    expect(lines).toContain("2048");
    tui.stop?.();
  });
});

describe("absorb hand", () => {
  async function withForge(put: number, items: { slug: string; repo: string }[], run: (url: string, puts: string[]) => Promise<void>) {
    const puts: string[] = [];
    const s = Bun.serve({
      port: 0,
      fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === "/api/v1/features" && req.method === "GET") return Response.json({ items });
        if (u.pathname.startsWith("/api/v1/features/") && req.method === "PUT") {
          puts.push(u.pathname);
          return new Response("{}", { status: put });
        }
        return new Response("no", { status: 404 });
      },
    });
    try {
      await run(`http://127.0.0.1:${s.port}`, puts);
    } finally {
      await s.stop(true);
    }
  }
  test("a listed app is absorbed through its own slug", async () => {
    await withForge(200, [{ slug: "other", repo: "o/other" }, { slug: "radar-1", repo: "o/radar" }], async (url, puts) => {
      expect(await realHands(url, "t").absorb("o", "radar")).toEqual({ ok: true });
      expect(puts).toEqual(["/api/v1/features/radar-1"]);
    });
  });
  test("an app that declares no feature fails the step and sends no PUT", async () => {
    await withForge(200, [{ slug: "other", repo: "o/other" }], async (url, puts) => {
      const r = await realHands(url, "t").absorb("o", "radar");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.why).toContain("declares no feature");
      expect(puts).toEqual([]);
    });
  });
  test("a 403 names the missing admin; another status is reported as is", async () => {
    await withForge(403, [{ slug: "radar", repo: "o/radar" }], async (url) => {
      const r = await realHands(url, "t").absorb("o", "radar");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.why).toMatch(/site admin/);
    });
    await withForge(500, [{ slug: "radar", repo: "o/radar" }], async (url) => {
      const r = await realHands(url, "t").absorb("o", "radar");
      if (!r.ok) expect(r.why).toContain("500");
      expect(r.ok).toBe(false);
    });
  });
  test("an unreachable forge fails the step", async () => {
    const r = await realHands("http://127.0.0.1:1", "t").absorb("o", "radar");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("cannot reach");
  });
});
