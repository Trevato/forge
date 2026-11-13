/** The real hands of a pack deploy: no credential leaves for a stranger's host, 409 alone means "exists", the terminal screen. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrg } from "../src/actions/orgs.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { deployPack } from "../src/packs/deploy.ts";
import { parsePack } from "../src/packs/pack.ts";
import { packNamed } from "../src/packs/catalog.ts";
import { fixturePacks, seedPacks } from "./helpers/packs.ts";
import { deployCommands } from "../src/packs/words.ts";
import { createForgeApp, forgeCommands } from "../src/tui/forge.ts";
import { packLines, packsScreen } from "../src/tui/screens/packs.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { cloneEnv, deployOrg, pushEnv, realHands } from "../scripts/pack.ts";
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


describe("deploy org", () => {
  test("the flag wins over FORGE_ORG, and an empty value is no target", () => {
    expect(deployOrg("leagues", { FORGE_ORG: "other" })).toBe("leagues");
    expect(deployOrg(undefined, { FORGE_ORG: "leagues" })).toBe("leagues");
    expect(deployOrg(undefined, {})).toBeUndefined();
    expect(deployOrg("  ", { FORGE_ORG: "" })).toBeUndefined();
  });

  test("makeApp with org creates the app under that org, not the token's account, and a second run keeps it there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pack-deploy-org-"));
    const app = createApp({ dataDir: dir, port: 0 });
    const servers = await serve(app);
    try {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: "ada",
        email: "ada@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!made.ok) throw new Error(made.error);
      const org = createOrg(app, made.value, "leagues");
      if (!org.ok) throw new Error(String(org.error));
      const token = createToken(app.db, made.value.id, "pack", "rw").token;
      const hands = realHands(servers.url, token, { org: "leagues" });
      const first = await hands.makeApp("directory", "A directory.");
      expect(first).toEqual({ ok: true, owner: "leagues" });
      expect((await fetch(`${servers.url}/leagues/directory`)).status).toBe(200);
      expect((await fetch(`${servers.url}/ada/directory`)).status).toBe(404);
      const again = await hands.makeApp("directory", "A directory.");
      expect(again.ok).toBe(false);
      if (!again.ok) {
        expect(again.exists).toBe(true);
        expect(again.owner).toBe("leagues");
      }
    } finally {
      await servers.stop();
      app.close();
      await rm(dir, { recursive: true, force: true });
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
  const games = fixturePacks().find((p) => p.name === "games")!;
  test("the clone source is the configured address, never a request's Host", () => {
    expect(deployCommands(games, "https://f.example/")[0]).toContain("git clone https://f.example/trevato/forge.git");
    expect(deployCommands(games, undefined)[0]).not.toContain("http");
  });
  test("the web page does not echo a forged Host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "packs-host-"));
    const a = createApp({ dataDir: dir, port: 0 });
    await seedPacks(a);
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
    await seedPacks(app);
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

describe("forge-repo sources", () => {
  const parsed = parsePack(
    JSON.stringify({
      pack: 1,
      name: "mine",
      title: "Mine",
      version: "1.0.0",
      description: "Apps from this forge.",
      apps: [
        { name: "radar", description: "A radar.", source: "trevato/radar" },
        { name: "notes", description: "Notes.", source: "trevato/notes" },
      ],
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error);

  test("deploying forks from the forge: one POST each, no network anywhere else, no history carried", async () => {
    const posts: string[] = [];
    const forge = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const u = new URL(req.url);
        posts.push(`${req.method} ${u.pathname} ${await req.text()}`);
        return u.pathname.endsWith("/notes/forks")
          ? Response.json({ error: "already_forked" }, { status: 409 })
          : Response.json({ ownerName: "me", name: "radar" }, { status: 201 });
      },
    });
    const real = globalThis.fetch;
    const hosts: string[] = [];
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const host = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).host;
      hosts.push(host);
      if (host.includes("github.com")) return Promise.reject(new Error("network to github.com refused"));
      return real(input, init);
    }) as typeof fetch;
    try {
      const hands = realHands(`http://127.0.0.1:${forge.port}`, "t", {
        cloneFrom: () => {
          throw new Error("history must not be carried over the network");
        },
      });
      const steps = await deployPack(parsed.value, hands);
      expect(steps.map((s) => [s.what, s.state])).toEqual([
        ["app radar", "done"],
        ["app notes", "kept"],
      ]);
      expect(posts).toEqual([
        'POST /api/v1/repos/trevato/radar/forks {"name":"radar"}',
        'POST /api/v1/repos/trevato/notes/forks {"name":"notes"}',
        "GET /api/v1/user ",
      ]);
      expect(hosts.every((h) => h === `127.0.0.1:${forge.port}`)).toBe(true);
    } finally {
      globalThis.fetch = real;
      await forge.stop(true);
    }
  });

  test("a refusal other than 409 (name taken, fork limit) fails that app's step with the forge's message, and the next app is still forked", async () => {
    const forge = Bun.serve({
      port: 0,
      fetch: (req) => {
        const u = new URL(req.url);
        if (u.pathname.endsWith("/radar/forks")) return Response.json({ error: "name_taken", message: "you already have a repository named radar" }, { status: 422 });
        return Response.json({ error: "rate_limited", message: "at most 5 forks a day" }, { status: 429 });
      },
    });
    try {
      const steps = await deployPack(parsed.value, realHands(`http://127.0.0.1:${forge.port}`, "t"));
      expect(steps).toEqual([
        { what: "app radar", state: "failed", note: "you already have a repository named radar" },
        { what: "app notes", state: "failed", note: "at most 5 forks a day" },
      ]);
    } finally {
      await forge.stop(true);
    }
  });

  test("an unreachable forge fails the fork step and says so", async () => {
    const r = await realHands("http://127.0.0.1:1", "t").forkFrom("trevato/radar", "radar");
    expect(r).toEqual({ ok: false, exists: false, why: "cannot reach http://127.0.0.1:1" });
  });

  test("absorb: true on a forge source absorbs the fork as its new owner", async () => {
    const absorbed: string[] = [];
    const refuse = () => Promise.reject(new Error("not used for a forge source"));
    const hands = {
      makeApp: refuse,
      defaultBranch: refuse,
      carryHistory: refuse,
      follow: refuse,
      makeAgent: refuse,
      forkFrom: async () => ({ ok: true as const, owner: "me" }),
      absorb: async (owner: string, name: string) => {
        absorbed.push(`${owner}/${name}`);
        return { ok: true as const };
      },
    };
    const pack = { ...parsed.value, apps: [{ ...parsed.value.apps[0]!, absorb: true }] };
    const steps = await deployPack(pack, hands);
    expect(steps.map((s) => [s.what, s.state])).toEqual([
      ["app radar", "done"],
      ["absorb radar", "done"],
    ]);
    expect(absorbed).toEqual(["me/radar"]);
  });

  test("the https form still parses", () => {
    const r = parsePack(JSON.stringify({ pack: 1, name: "mine", title: "Mine", version: "1.0.0", description: "d", apps: [{ name: "x", description: "d", source: "https://github.com/a/b.git" }] }));
    expect(r.ok && r.value.apps[0]!.source).toBe("https://github.com/a/b");
  });
});
