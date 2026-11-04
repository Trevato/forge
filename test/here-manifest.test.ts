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
import { createApp, type App } from "../src/app.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { markVerified, resetVerification } from "../src/core/verify.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("the manifest: what you can do here, as who you are", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  const tokens: Record<string, string> = {};
  let usersByName: Record<string, User> = {};

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
      ["una", false],
    ] as const) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: name,
        email: `${name}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
      users[name] = made.value;
    }
    promote(app.db, ...Object.values(users));
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
    const pub = await newApp(app, alice, {
      name: "pub",
      owner: "acme",
      visibility: "public",
    });
    if (!pub.ok) throw new Error(String(pub.error));
    const plain = await createRepo(app, alice, {
      name: "plain",
      owner: "acme",
      visibility: "public",
    });
    if (!plain.ok) throw new Error(String(plain.error));
    const bot = await createAgent(app, alice, { username: "bot" });
    if (!bot.ok) throw new Error(String(bot.error));
    expect(addToCrew(app, alice, game.value.repo, "bot").ok).toBe(true);

    // Carol proved her email; Una has not yet.
    markVerified(app.db, users["carol"]!.id, new Date().toISOString());
    resetVerification(app.db, users["una"]!.id);
    usersByName = users;
    for (const name of ["alice", "wes", "carol", "una"])
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

  test("a writer of a fork is offered how it follows its parent; a reader and a plain repository's writer are not", async () => {
    const fork = await forkRepo(app, usersByName["wes"]!, getRepo(app.db, "acme", "game")!);
    if (!fork.ok) throw new Error(String(fork.error));
    const path = "/wes/game";
    const moves = [
      "read how it follows its parent",
      "take the parent's updates",
      "propose its changes to the parent",
    ];
    const { body } = await manifest(path, "wes");
    for (const d of moves) expect(does(body)).toContain(d);
    expect(body.actions.find((a: any) => a.do === moves[1]).http).toBe(
      "POST /api/v1/repos/wes/game/following/take",
    );
    expect(moves.map((d) => body.actions.find((a: any) => a.do === d).mcp)).toEqual([
      "following",
      "take_updates",
      "propose_to_parent_forge",
    ]);
    for (const who of ["carol", undefined])
      for (const d of moves)
        expect(does((await manifest(path, who)).body)).not.toContain(d);
    for (const d of moves)
      expect(does((await manifest("/acme/game", "wes")).body)).not.toContain(d);
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

  test("the forge's manifest names how to help, for anyone; a repository's does not", async () => {
    for (const who of [undefined, "carol"]) {
      const { body, size } = await manifest("/", who);
      expect(body.actions).toContainEqual({
        do: "see how to help build this forge",
        http: "GET /api/v1/contribute",
        mcp: "contribute",
      });
      expect(size).toBeLessThan(2048);
      expect(does((await manifest("/acme/game", who)).body)).not.toContain(
        "see how to help build this forge",
      );
    }
  });

  test("the forge's manifest names the changelog, for anyone", async () => {
    for (const who of [undefined, "carol"]) {
      const { body, size } = await manifest("/", who);
      expect(body.actions).toContainEqual({
        do: "see what went live",
        http: "GET /api/v1/changelog",
        mcp: "releases",
      });
      expect(size).toBeLessThan(2048);
    }
  });

  test("an anonymous viewer is told how to get an account; a signed-in one is not", async () => {
    const anon = (await manifest("/")).body.actions;
    expect(anon).toContainEqual({
      do: "make an account",
      http: "GET /signup",
      account: false,
    });
    expect(anon).toContainEqual({
      do: "sign in",
      http: "GET /signin",
      account: false,
    });
    expect(anon.findIndex((a: any) => a.do === "use the MCP")).toBeLessThan(
      anon.findIndex((a: any) => a.do === "make an account"),
    );
    const signedIn = does((await manifest("/", "carol")).body);
    expect(signedIn).not.toContain("make an account");
    expect(signedIn).not.toContain("sign in");
  });

  test("an edge-login forge offers sign in but no sign-up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-here-edge-"));
    const edgeApp = createApp({ dataDir: dir, port: 0, edgeToken: "e" });
    const edgeServers = await serve(edgeApp);
    try {
      const res = await fetch(`${edgeServers.url}/api/v1/here`);
      const names = (await res.json() as any).actions.map((a: any) => a.do);
      expect(names).toContain("sign in");
      expect(names).not.toContain("make an account");
    } finally {
      edgeServers.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the forge's manifest names the OpenAPI document, and it answers", async () => {
    for (const who of [undefined, "carol"]) {
      const { body, size } = await manifest("/", who);
      expect(body.actions).toContainEqual({
        do: "read the HTTP contract",
        http: "GET /contract/openapi.json",
        account: false,
      });
      expect(size).toBeLessThan(2048);
    }
    const res = await fetch(`${base}/contract/openapi.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("/explore and /search name their query API and MCP tool, the query carried over", async () => {
    for (const who of [undefined, "carol"]) {
      const e = (await manifest("/explore?q=kind:app", who)).body;
      expect(e.here).toEqual({ kind: "explore" });
      expect(e.actions[0].http).toBe("GET /api/v1/explore?q=kind:app");
      expect(e.actions[0].mcp).toBe("explore");
      const s = (await manifest("/search", who)).body;
      expect(s.here).toEqual({ kind: "search" });
      expect(s.actions[0].http).toBe("GET /api/v1/search");
      expect(s.actions[0].mcp).toBe("search");
      const f = (await manifest("/", who)).body;
      expect(f.here.kind).toBe("forge");
      expect(f.actions.map((a: any) => a.mcp)).toEqual(
        expect.arrayContaining(["explore", "search"]),
      );
      for (const a of f.actions)
        if (a.mcp === "explore" || a.mcp === "search")
          expect(a.account).toBeUndefined();
    }
    const q = (await manifest("/search?q=a%20b%26c")).body;
    expect(q.actions[0].http).toBe("GET /api/v1/search?q=a%20b%26c");
    const other = (await manifest("/settings")).body;
    expect(other.here).toEqual({ kind: "forge" });
    expect(other.actions[0].do).toBe("explore apps and repositories");
  });

  test("the explore and search actions name the MCP argument q", async () => {
    const e = (await manifest("/explore?q=kind:app")).body;
    expect(e.actions[0].mcpArgs).toEqual({ q: "kind:app" });
    const long = (await manifest(`/search?q=${"x".repeat(300)}`)).body;
    expect(long.actions[0].mcpArgs.q).toHaveLength(200);
    const f = (await manifest("/")).body;
    for (const tool of ["explore", "search"])
      expect(f.actions.find((a: any) => a.mcp === tool).mcpArgs).toHaveProperty("q");
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

  // ── follow-ups from the first review ──────────────────────────────────

  test("an account whose email is unproven is told that offering a change needs a verified email", async () => {
    const una = (await manifest("/acme/game", "una")).body;
    const offer = una.actions.find((a: any) => a.do === "offer a change");
    expect(offer.verify).toBe(true);
    const carol = (await manifest("/acme/game", "carol")).body;
    expect(carol.actions.find((a: any) => a.do === "offer a change").verify).toBeUndefined();
  });

  test("a repository with an app offers make it yours to whoever cannot write it", async () => {
    const find = (m: any) => m.actions.find((a: any) => a.do === "make it yours");
    const carol = find((await manifest("/acme/pub", "carol")).body);
    expect(carol).toEqual({
      do: "make it yours",
      http: "POST /api/v1/repos/acme/pub/make-it-yours",
      mcp: "make_it_yours",
    });
    expect(find((await manifest("/acme/pub", "una")).body).verify).toBe(true);
    const out = find((await manifest("/acme/pub")).body);
    expect(out.account).toBe(true);
    expect(out.verify).toBeUndefined();
  });

  test("a writer, and a repository without an app, are not offered make it yours", async () => {
    expect(does((await manifest("/acme/pub", "wes")).body)).not.toContain("make it yours");
    expect(does((await manifest("/acme/pub", "alice")).body)).not.toContain("make it yours");
    expect(does((await manifest("/acme/plain", "carol")).body)).not.toContain("make it yours");
    expect(does((await manifest("/acme/plain")).body)).not.toContain("make it yours");
  });

  test("an org's own pages are the org's, not a missing repository", async () => {
    const res = await here("/acme/-/teams/Writers", "alice");
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).here).toEqual({ kind: "org", org: "acme" });
  });

  test("a suspended person's page is not_found like an unknown name, except to an admin", async () => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "gone",
      email: "gone@forge.local",
      password: "a-good-passphrase",
    });
    if (!made.ok) throw new Error(made.error);
    app.db.run("UPDATE user SET suspended_at = ?1 WHERE id = ?2", [
      new Date().toISOString(),
      made.value.id,
    ]);
    const unknown = await (await here("/nope")).json();
    for (const who of [undefined, "carol"]) {
      const res = await here("/gone", who);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(unknown);
    }
    const { body } = await manifest("/gone", "alice");
    expect(body.here).toEqual({ kind: "person", username: "gone" });
  });

  test("one segment is a person, an org, nobody, or one of the forge's own names", async () => {
    const person = (await manifest("/wes")).body;
    expect(person.here).toEqual({ kind: "person", username: "wes" });
    expect(person.actions[0].http).toBe("GET /api/v1/users/wes/repos");
    const org = (await manifest("/ACME", "carol")).body;
    expect(org.here).toEqual({ kind: "org", org: "acme" });
    expect(org.actions[0].http).toBe("GET /api/v1/orgs/acme/teams");
    const nobody = await here("/nope");
    expect(nobody.status).toBe(404);
    expect(await nobody.json()).toEqual(await (await here("/acme/nothing")).json());
    expect((await manifest("/settings")).body.here.kind).toBe("forge");
    expect((await manifest("/explore")).body.here.kind).toBe("explore");
    expect((await manifest("/search?q=x")).body.here.kind).toBe("search");
    const mcp = (await (
      await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${tokens["carol"]}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "here", arguments: { url: `${base}/wes` } },
        }),
      })
    ).json()) as any;
    expect(JSON.parse(mcp.result.content[0].text).here.kind).toBe("person");
  });

  test("a pull page says whether the pull's code runs, or waits for a writer's approval", async () => {
    const game = getRepo(app.db, "acme", "game")!;
    const carol = usersByName["carol"]!;
    const forked = await forkRepo(app, carol, game);
    if (!forked.ok) throw new Error(String(forked.error));
    const committed = await commitToBranch(app, carol, forked.value, {
      branch: "idea",
      message: "An idea",
      files: [{ path: "IDEA.md", content: "idea\n" }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const opened = await openPull(app, carol, game, {
      title: "An idea",
      baseBranch: "main",
      headBranch: "idea",
      headRepo: forked.value,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const { body } = await manifest(`/acme/game/pulls/${opened.value.number}`, "carol");
    expect(body.here.pull).toEqual({ number: opened.value.number, runs: false });
    const mine = await commitToBranch(app, usersByName["alice"]!, game, {
      branch: "mine",
      message: "Mine",
      files: [{ path: "MINE.md", content: "mine\n" }],
    });
    if (!mine.ok) throw new Error(JSON.stringify(mine.error));
    const own = await openPull(app, usersByName["alice"]!, game, {
      title: "Mine",
      baseBranch: "main",
      headBranch: "mine",
    });
    if (!own.ok) throw new Error(String(own.error));
    const ownBody = (await manifest(`/acme/game/pulls/${own.value.number}`)).body;
    expect(ownBody.here.pull).toEqual({ number: own.value.number, runs: true });
  });

  test("on /explore the page read is not repeated by the generic one", async () => {
    const { body } = await manifest("/explore?q=kind:app");
    const reads = body.actions.filter((a: any) => a.mcp === "explore");
    expect(reads.length).toBe(1);
    expect(reads[0].http).toBe("GET /api/v1/explore?q=kind:app");
    expect(body.actions.filter((a: any) => a.mcp === "search").length).toBe(1);
  });
});
