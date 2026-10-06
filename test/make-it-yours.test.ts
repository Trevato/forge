/**
 * Make it yours (#606): one action forks an app into the viewer's account,
 * registers it as their app and lands them on it; a plan first, everywhere.
 * The code and its history are copied; the app's data, variables, secrets
 * and crew are not; the original is untouched. The Friend test: a second
 * account makes one of the owner's public apps theirs in one action.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { suspendAccount } from "../src/actions/accounts.ts";
import { newApp } from "../src/actions/apps.ts";
import { createAgent } from "../src/actions/crew.ts";
import { makeItYours } from "../src/actions/make_it_yours.ts";
import { envDataDir } from "../src/apps/data.ts";
import { getAppByRepo, listApps, type AppRecord } from "../src/core/apps.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserById, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("make it yours", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let garden: Repo;
  let gardenApp: AppRecord;
  let bobCookie: string;
  let bobToken: string;
  let bobRo: string;

  const api = (path: string, token: string | undefined, body: unknown) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-make-it-yours-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const r = await createUser(app.db, {
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    alice = await mk("alice", true);
    bob = await mk("bob");
    const made = await newApp(app, alice, {
      name: "garden",
      description: "A garden planner",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    garden = made.value.repo;
    gardenApp = made.value.app;
    // What is the original owner's: a variable, a secret, and data.
    app.db
      .query(
        `INSERT INTO app_env (app_id, name, value_enc) VALUES (?1, 'API_KEY', 'x')`,
      )
      .run(gardenApp.id);
    app.db
      .query(
        `INSERT INTO secret (name, scope, scope_id, value_enc) VALUES ('DEPLOY_TOKEN', 'repo', ?1, 'x')`,
      )
      .run(garden.id);
    const data = envDataDir(dataDir, gardenApp.id, "production");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "beds.json"), '{"tomatoes":3}');
    bobCookie = `forge_session=${createSession(app.db, bob.id).token}`;
    bobToken = createToken(app.db, bob.id, "rw", "rw").token;
    bobRo = createToken(app.db, bob.id, "ro", "ro").token;
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a plan first: what will be copied and what will not, and nothing made", async () => {
    const before = listApps(app.db).length;
    const res = await api(
      "/api/v1/repos/alice/garden/make-it-yours",
      bobRo,
      {},
    );
    expect(res.status).toBe(200);
    const plan = (await res.json()) as any;
    expect(plan).toMatchObject({
      dryRun: true,
      from: "alice/garden",
      repo: "bob/garden",
      slug: "garden-bob",
      existing: false,
    });
    expect(plan.copied).toEqual(["the code", "its history"]);
    expect(plan.notCopied).toContain("the app's data");
    expect(plan.notCopied).toContain("its variables and secrets");
    expect(getRepo(app.db, "bob", "garden")).toBeUndefined();
    expect(listApps(app.db).length).toBe(before);
    // The page says the same before anyone says yes.
    const page = await (
      await fetch(`${servers.url}/alice/garden/make-it-yours`, {
        headers: { cookie: `${bobCookie}; forge_mode=studio` },
      })
    ).text();
    expect(page).toContain("Make it yours");
    expect(page).toContain("bob/garden");
    expect(page).toContain("its variables and secrets");
    // An ro token may plan, never make; a stranger neither; the owner has it.
    expect(
      (
        await api("/api/v1/repos/alice/garden/make-it-yours", bobRo, {
          dryRun: false,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api("/api/v1/repos/alice/garden/make-it-yours", undefined, {
          dryRun: false,
        })
      ).status,
    ).toBe(401);
    const own = createToken(app.db, alice.id, "rw", "rw").token;
    expect(
      (
        await api("/api/v1/repos/alice/garden/make-it-yours", own, {
          dryRun: false,
        })
      ).status,
    ).toBe(409);
  });

  test("the Friend test: one action, and bob has the app as his own — the code, not the data or secrets; the original untouched", async () => {
    const posted = await fetch(`${servers.url}/alice/garden/make-it-yours`, {
      method: "POST",
      headers: { cookie: bobCookie, origin: servers.url },
      redirect: "manual",
    });
    expect(posted.status).toBe(303);
    expect(posted.headers.get("location")).toBe("/bob/garden");
    const copy = getRepo(app.db, "bob", "garden")!;
    expect(copy.forkParentId).toBe(garden.id);
    const copyApp = getAppByRepo(app.db, copy.id)!;
    expect(copyApp.slug).toBe("garden-bob");
    // Not copied: variables, secrets, data.
    expect(
      app.db
        .query(`SELECT COUNT(*) AS n FROM app_env WHERE app_id = ?1`)
        .get(copyApp.id),
    ).toEqual({ n: 0 });
    expect(
      app.db
        .query(
          `SELECT COUNT(*) AS n FROM secret WHERE scope = 'repo' AND scope_id = ?1`,
        )
        .get(copy.id),
    ).toEqual({ n: 0 });
    const copyData = envDataDir(dataDir, copyApp.id, "production");
    expect(!existsSync(copyData) || readdirSync(copyData).length === 0).toBe(
      true,
    );
    // The original: one app, its own, its data and variable where they were.
    expect(getAppByRepo(app.db, garden.id)!.id).toBe(gardenApp.id);
    expect(
      app.db
        .query(`SELECT COUNT(*) AS n FROM app_env WHERE app_id = ?1`)
        .get(gardenApp.id),
    ).toEqual({ n: 1 });
    expect(
      existsSync(
        join(envDataDir(dataDir, gardenApp.id, "production"), "beds.json"),
      ),
    ).toBe(true);
  });

  test("again lands on the copy already made; MCP plans and makes the same", async () => {
    const again = await api(
      "/api/v1/repos/alice/garden/make-it-yours",
      bobToken,
      { dryRun: false },
    );
    expect(again.status).toBe(201);
    expect(await again.json()).toMatchObject({
      existing: true,
      repo: "bob/garden",
      url: "/bob/garden",
    });
    const call = async (args: unknown) => {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${bobToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "make_it_yours", arguments: args },
        }),
      });
      const body = (await res.json()) as any;
      return JSON.parse(body.result.content[0].text);
    };
    expect(await call({ repo: "alice/garden" })).toMatchObject({
      dryRun: true,
      existing: true,
    });
  });

  test("the app's page offers it to a reader, never to its owner", async () => {
    const asBob = await (
      await fetch(`${servers.url}/alice/garden`, {
        headers: { cookie: `${bobCookie}; forge_mode=studio` },
      })
    ).text();
    expect(asBob).toContain('href="/alice/garden/make-it-yours"');
    const aliceCookie = `forge_session=${createSession(app.db, alice.id).token}`;
    const asAlice = await (
      await fetch(`${servers.url}/alice/garden`, {
        headers: { cookie: `${aliceCookie}; forge_mode=studio` },
      })
    ).text();
    expect(asAlice).not.toContain("make-it-yours");
  });

  test("refused, by the action and the API: an agent, an unverified account, a suspended one, a stranger to a private repository, a stranger to a public repository's private app, and the owner", async () => {
    const mk = async (username: string, trusted = true) => {
      const r = await createUser(app.db, {
        trusted,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
      });
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    // A private repository, and a public one whose app is private.
    const vault = await newApp(app, alice, { name: "vault", visibility: "private" });
    const lab = await newApp(app, alice, { name: "lab", visibility: "private" });
    if (!vault.ok || !lab.ok) throw new Error("apps");
    app.db.query(`UPDATE repo SET visibility = 'public' WHERE id = ?1`).run(lab.value.repo.id);
    expect(lab.value.app.access).toBe("private");
    const labRepo = getRepo(app.db, "alice", "lab")!;
    const vaultRepo = getRepo(app.db, "alice", "vault")!;
    const carol = await mk("carol");
    const tokenOf = (u: User) => createToken(app.db, u.id, "rw", "rw").token;
    const make = (path: string, token: string) =>
      api(`/api/v1/repos/${path}/make-it-yours`, token, { dryRun: false });
    const appsBefore = listApps(app.db).length;

    // A stranger to a private repository, and to a public repository's
    // private app: not there, by the action and the API — even as a plan.
    for (const repo of [vaultRepo, labRepo]) {
      for (const dryRun of [true, false]) {
        const by = await makeItYours(app, carol, repo, { dryRun });
        expect(by.ok).toBe(false);
        if (!by.ok) expect(by.error.kind).toBe("not_found");
      }
    }
    expect((await make("alice/vault", tokenOf(carol))).status).toBe(404);
    expect((await make("alice/lab", tokenOf(carol))).status).toBe(404);
    expect(
      (await api("/api/v1/repos/alice/lab/make-it-yours", tokenOf(carol), {})).status,
    ).toBe(404);

    // An agent does not make apps its own.
    const agent = await createAgent(app, alice, { username: "helper" });
    if (!agent.ok) throw new Error(String(agent.error));
    const byAgent = await makeItYours(app, agent.value.user, garden, { dryRun: false });
    expect(byAgent.ok).toBe(false);
    if (!byAgent.ok) expect(byAgent.error.kind).toBe("invalid");
    expect((await make("alice/garden", tokenOf(agent.value.user))).status).toBe(422);

    // An account whose email is not proven.
    const dana = await mk("dana", false);
    const byDana = await makeItYours(app, dana, garden, { dryRun: false });
    expect(byDana.ok).toBe(false);
    if (!byDana.ok) expect(byDana.error.kind).toBe("unverified");
    expect((await make("alice/garden", tokenOf(dana))).status).toBe(403);

    // A suspended account.
    const erin = await mk("erin");
    expect((await suspendAccount(app, alice, "erin")).ok).toBe(true);
    const suspended = getUserById(app.db, erin.id)!;
    const byErin = await makeItYours(app, suspended, garden, { dryRun: false });
    expect(byErin.ok).toBe(false);
    if (!byErin.ok) expect(byErin.error.kind).toBe("unauthorized");
    expect((await make("alice/garden", tokenOf(erin))).status).toBe(401);

    // The owner already has it.
    const byOwner = await makeItYours(app, alice, garden, { dryRun: false });
    expect(byOwner.ok).toBe(false);
    if (!byOwner.ok) expect(byOwner.error.kind).toBe("own");

    // None of them made anything.
    expect(listApps(app.db).length).toBe(appsBefore);
    for (const who of ["carol", "helper", "dana", "erin"])
      expect(app.db.query(`SELECT COUNT(*) AS n FROM repo JOIN user ON user.id = repo.owner_id WHERE user.username = ?1`).get(who)).toEqual({ n: 0 });
  });
});
