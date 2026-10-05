/**
 * Every page says what you can do here as who you are (#604): a compact
 * JSON manifest per page, linked from the page, computed from the same
 * checks the routes use. It never promises what a route refuses, and never
 * names a private repository, app or person the viewer could not already see.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp, updateAppSettings } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the manifest: what you can do here, as who you are", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-here-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const users: Record<string, User> = {};
    for (const [name, first] of [
      ["alice", true],
      ["wes", false],
      ["carol", false],
    ] as const) {
      const made = await createUser(app.db, {
        trusted: true,
        username: name,
        email: `${name}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
      users[name] = made.value;
    }
    const alice = users["alice"]!;
    const org = createOrg(app.db, "acme", alice.id);
    if (!org.ok) throw new Error(org.error);
    const writers = createTeam(app.db, org.value.id, "Writers", "write");
    if (!writers.ok) throw new Error(String(writers.error));
    addTeamMember(app.db, writers.value, users["wes"]!.id);

    // A public repository whose app is private, and a private repository.
    const game = await newApp(app, alice, {
      name: "game",
      owner: "acme",
      visibility: "public",
    });
    if (!game.ok) throw new Error(String(game.error));
    const set = updateAppSettings(app, alice, game.value.repo, {
      access: "private",
    });
    expect(set.ok).toBe(true);
    const vault = await createRepo(app, alice, {
      name: "vault",
      owner: "acme",
      visibility: "private",
    });
    if (!vault.ok) throw new Error(String(vault.error));
    const bot = await createAgent(app, alice, { username: "bot" });
    if (!bot.ok) throw new Error(String(bot.error));
    expect(addToCrew(app, alice, game.value.repo, "bot").ok).toBe(true);

    for (const name of ["alice", "wes", "carol"])
      tokens[name] = createToken(app.db, users[name]!.id, "t", "rw").token;
    tokens["bot"] = createToken(app.db, bot.value.user.id, "run", "rw").token;
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const here = (path: string, who?: string) =>
    fetch(`${base}/api/v1/here?path=${encodeURIComponent(path)}`, {
      headers:
        who === undefined ? {} : { authorization: `Bearer ${tokens[who]}` },
    });
  const manifest = async (path: string, who?: string) => {
    const res = await here(path, who);
    expect(res.status).toBe(200);
    return {
      body: (await res.json()) as any,
      size: Number(res.headers.get("content-length") ?? 0),
      text: "",
    };
  };
  const does = (m: any): string[] => m.actions.map((a: any) => a.do);

  // ── refusals first ────────────────────────────────────────────────────

  test("a private repository is not_found to anyone who cannot read it, exactly as a missing one", async () => {
    for (const who of [undefined, "carol"]) {
      const hidden = await here("/acme/vault", who);
      const missing = await here("/acme/nothing", who);
      expect(hidden.status).toBe(404);
      expect(await hidden.json()).toEqual(await missing.json());
      const deep = await here("/acme/vault/issues/1", who);
      expect(deep.status).toBe(404);
    }
  });

  test("a reader of a public repository learns nothing of its private app", async () => {
    for (const who of [undefined, "carol"]) {
      const { body } = await manifest("/acme/game", who);
      const text = JSON.stringify(body);
      expect(body.here.app).toBeUndefined();
      expect(text).not.toContain("/app/");
      expect(does(body)).not.toContain("open the app");
    }
  });

  test("it never promises what a route refuses: an anonymous visitor is told what needs an account", async () => {
    const { body } = await manifest("/acme/game");
    expect(body.you.as).toBe("anonymous");
    const byName = new Map<string, any>(
      body.actions.map((a: any) => [a.do, a]),
    );
    expect(byName.get("report a problem").account).toBe(false);
    expect(byName.get("report a problem").mcp).toBe("report");
    expect(byName.get("open an issue").account).toBe(true);
    expect(byName.get("offer a change").account).toBe(true);
    for (const writerOnly of [
      "merge a pull",
      "approve a pull",
      "tell the crew",
      "change settings",
    ])
      expect(byName.has(writerOnly)).toBe(false);
    // Following what it says does what it says.
    const report = byName.get("report a problem");
    const [method, path] = report.http.split(" ");
    const filed = await fetch(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.40",
      },
      body: JSON.stringify({ title: "It is down" }),
    });
    expect(filed.status).toBe(202);
  });

  // ── who you are ───────────────────────────────────────────────────────

  test("a signed-in reader may open an issue and offer a change, not merge or direct the crew", async () => {
    const { body } = await manifest("/acme/game", "carol");
    expect(body.you).toEqual({ as: "reader", name: "carol" });
    const list = does(body);
    expect(list).toContain("open an issue");
    expect(list).toContain("offer a change");
    expect(list).not.toContain("merge a pull");
    expect(list).not.toContain("tell the crew");
  });

  test("a writer enters the private app, directs the crew and merges; not the settings", async () => {
    const { body } = await manifest("/acme/game", "wes");
    expect(body.you.as).toBe("writer");
    expect(body.here.app).toMatchObject({ access: "private" });
    const list = does(body);
    for (const d of [
      "open the app",
      "tell the crew",
      "merge a pull",
      "approve a pull",
    ])
      expect(list).toContain(d);
    expect(list).not.toContain("change settings");
  });

  test("the owner also changes the settings", async () => {
    const { body } = await manifest("/acme/game", "alice");
    expect(body.you.as).toBe("owner");
    expect(does(body)).toContain("change settings");
  });

  test("an agent token on the crew is an agent: it enters the app, and never merges", async () => {
    const { body } = await manifest("/acme/game", "bot");
    expect(body.you.as).toBe("agent");
    expect(does(body)).toContain("open the app");
    expect(does(body)).not.toContain("merge a pull");
  });

  test("the forge's own pages get the forge's manifest; the MCP and its OAuth are named", async () => {
    const { body } = await manifest("/");
    expect(body.here.kind).toBe("forge");
    expect(body.mcp.url).toBe(`${base}/mcp`);
    expect(body.mcp.oauth).toBe(`${base}/.well-known/oauth-protected-resource`);
    expect(body.docs).toBe(`${base}/llms.txt`);
    expect(JSON.stringify(body)).not.toContain("vault");
  });

  test("it is small", async () => {
    for (const who of [undefined, "carol", "wes", "alice", "bot"]) {
      const res = await here("/acme/game", who);
      expect((await res.text()).length).toBeLessThan(2048);
    }
  });

  test("every page links to its manifest, as a link relation and a Link header", async () => {
    const page = await fetch(`${base}/acme/game`);
    const href = `/api/v1/here?path=${encodeURIComponent("/acme/game")}`;
    expect(page.headers.get("link") ?? "").toContain(
      `<${href}>; rel="alternate"; type="application/json"`,
    );
    expect(await page.text()).toContain(`rel="alternate"`);
  });

  test("the MCP's `here` answers the same for a URL", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${tokens["carol"]}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "here",
          arguments: { url: `${base}/acme/game/issues` },
        },
      }),
    });
    const answer = (await res.json()) as any;
    const body = JSON.parse(answer.result.content[0].text);
    expect(body.you.as).toBe("reader");
    expect(body.here.name).toBe("acme/game");
    const hidden = (await (
      await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokens["carol"]}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "here", arguments: { url: `${base}/acme/vault` } },
        }),
      })
    ).json()) as any;
    expect(hidden.result.isError).toBe(true);
    expect(hidden.result.content[0].text).toStartWith("not_found");
  });
});
