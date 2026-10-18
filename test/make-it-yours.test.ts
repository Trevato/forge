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
import { deleteRepo, forkRepo } from "../src/actions/repos.ts";
import { createAgent } from "../src/actions/crew.ts";
import { COPIES_PER_DAY, makeItYours } from "../src/actions/make_it_yours.ts";
import { envDataDir } from "../src/apps/data.ts";
import { getAppByRepo, listApps, type AppRecord } from "../src/core/apps.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserById, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

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
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!r.ok) throw new Error(r.error);
      promote(app.db, r.value);
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
        origin: "seed",
        trusted,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
      });
      if (!r.ok) throw new Error(r.error);
      promote(app.db, r.value);
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

  test("a copy starts private unless chosen public, and never public from a private original (#852)", async () => {
    const frank = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "frank",
      email: "frank@forge.local",
      password: "a-good-passphrase",
    });
    if (!frank.ok) throw new Error(frank.error);
    promote(app.db, frank.value);
    const plan = await makeItYours(app, frank.value, garden, { dryRun: true });
    expect(plan.ok && plan.value.visibility).toBe("private");
    const made = await makeItYours(app, frank.value, garden, { dryRun: false });
    if (!made.ok || made.value.made === undefined) throw new Error("not made");
    expect(made.value.made.repo.visibility).toBe("private");
    expect(made.value.made.app.access).toBe("private");
    expect(getRepo(app.db, "frank", "garden")!.visibility).toBe("private");
    // Chosen public, it is public — app and code.
    const other = await newApp(app, alice, { name: "orchard", visibility: "public" });
    if (!other.ok) throw new Error("orchard");
    const open = await api("/api/v1/repos/alice/orchard/make-it-yours", createToken(app.db, frank.value.id, "rw", "rw").token, {
      dryRun: false,
      visibility: "public",
    });
    expect(open.status).toBe(201);
    expect(getRepo(app.db, "frank", "orchard")!.visibility).toBe("public");
    expect(getAppByRepo(app.db, getRepo(app.db, "frank", "orchard")!.id)!.access).toBe("public");
    // A private original's copy stays private, whoever asks.
    const secret = await newApp(app, frank.value, { name: "secret-plot", visibility: "private" });
    if (!secret.ok) throw new Error("secret");
    const asAdmin = await makeItYours(app, alice, secret.value.repo, { dryRun: true, visibility: "public" });
    expect(asAdmin.ok).toBe(false);
    if (!asAdmin.ok) expect(asAdmin.error.kind).toBe("invalid");
  }, 60_000);

  test("at most five copies an account a day; the sixth is refused and nothing made; landing on a copy already made still works (#853)", async () => {
    const gina = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "gina",
      email: "gina@forge.local",
      password: "a-good-passphrase",
    });
    if (!gina.ok) throw new Error(gina.error);
    promote(app.db, gina.value);
    const token = createToken(app.db, gina.value.id, "rw", "rw").token;
    for (let n = 0; n < COPIES_PER_DAY; n++) {
      const src = await newApp(app, alice, { name: `bed-${n}`, visibility: "public" });
      if (!src.ok) throw new Error("bed");
      const made = await makeItYours(app, gina.value, src.value.repo, { dryRun: false });
      expect(made.ok).toBe(true);
    }
    const sixth = await newApp(app, alice, { name: "bed-extra", visibility: "public" });
    if (!sixth.ok) throw new Error("bed-extra");
    const plan = await makeItYours(app, gina.value, sixth.value.repo, { dryRun: true });
    expect(plan.ok && plan.value.copiesLeft).toBe(0);
    const refused = await makeItYours(app, gina.value, sixth.value.repo, { dryRun: false });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.kind).toBe("limit");
      if (refused.error.kind === "limit")
        expect(Date.parse(refused.error.resetsAt)).toBeGreaterThan(Date.now());
    }
    const viaApi = await api("/api/v1/repos/alice/bed-extra/make-it-yours", token, { dryRun: false });
    expect(viaApi.status).toBe(429);
    expect(getRepo(app.db, "gina", "bed-extra")).toBeUndefined();
    // A day later, one may be made again.
    const tomorrow = await makeItYours(app, gina.value, sixth.value.repo, { dryRun: true }, Date.now() + 86_400_000 + 1000);
    expect(tomorrow.ok && tomorrow.value.copiesLeft).toBe(COPIES_PER_DAY);
    // Landing on a copy already made is not a new copy.
    const again = await makeItYours(app, gina.value, getRepo(app.db, "alice", "bed-0")!, { dryRun: false });
    expect(again.ok && again.value.existing).toBe(true);
  }, 120_000);

  describe("#888: born private, and one limit on every way to copy", () => {
    const person = async (username: string) => {
      const r = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
      });
      if (!r.ok) throw new Error(r.error);
      promote(app.db, r.value);
      return r.value;
    };
    const source = async (name: string) => {
      const made = await newApp(app, alice, { name, visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
      return made.value.repo;
    };

    test("a private copy of a public app is never, even for a moment, public", async () => {
      // Every row the repo table is ever written with, as it was written.
      app.db.run(`CREATE TEMP TABLE IF NOT EXISTS seen_repo (name TEXT, visibility TEXT, at TEXT)`);
      app.db.run(`CREATE TEMP TRIGGER IF NOT EXISTS seen_insert AFTER INSERT ON repo BEGIN INSERT INTO seen_repo VALUES (NEW.name, NEW.visibility, 'insert'); END`);
      app.db.run(`CREATE TEMP TRIGGER IF NOT EXISTS seen_update AFTER UPDATE OF visibility ON repo BEGIN INSERT INTO seen_repo VALUES (NEW.name, NEW.visibility, 'update'); END`);
      const hana = await person("hana");
      const src = await source("meadow");
      const made = await makeItYours(app, hana, src, { dryRun: false });
      expect(made.ok).toBe(true);
      // Alice's original was written public; hana's copy was written
      // private, and never changed after.
      const written = app.db
        .query<{ visibility: string; at: string }, []>(
          `SELECT visibility, at FROM seen_repo WHERE name = 'meadow' ORDER BY rowid`,
        )
        .all();
      expect(written).toEqual([
        { visibility: "public", at: "insert" },
        { visibility: "private", at: "insert" },
      ]);
      expect(getRepo(app.db, "hana", "meadow")!.visibility).toBe("private");
    });

    test("the plain fork is held to the same daily limit, by the action, the API and the page; an agent's working fork is not", async () => {
      const ivan = await person("ivan");
      const token = createToken(app.db, ivan.id, "rw", "rw").token;
      for (let n = 0; n < COPIES_PER_DAY; n++) {
        const forked = await forkRepo(app, ivan, await source(`lane-${n}`));
        expect(forked.ok).toBe(true);
      }
      const next = await source("lane-extra");
      const byAction = await forkRepo(app, ivan, next);
      expect(byAction.ok).toBe(false);
      if (!byAction.ok) expect(byAction.error).toBe("limit");
      const byApi = await fetch(`${servers.url}/api/v1/repos/alice/lane-extra/forks`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: "{}",
      });
      expect(byApi.status).toBe(429);
      const ivanCookie = `forge_session=${createSession(app.db, ivan.id).token}`;
      const byPage = await fetch(`${servers.url}/alice/lane-extra/fork`, {
        method: "POST",
        headers: { cookie: ivanCookie, origin: servers.url },
        redirect: "manual",
      });
      expect(byPage.status).toBe(303);
      expect(decodeURIComponent(byPage.headers.get("set-cookie") ?? "")).toContain("forks made");
      // Nor does make it yours go around it: the fork and then the app.
      const viaCopy = await makeItYours(app, ivan, next, { dryRun: false });
      expect(viaCopy.ok).toBe(false);
      if (!viaCopy.ok) expect(viaCopy.error.kind).toBe("limit");
      expect(getRepo(app.db, "ivan", "lane-extra")).toBeUndefined();
      // The crew's agents fork per issue to work: not held to it.
      const agent = await createAgent(app, alice, { username: "worker-bee" });
      if (!agent.ok) throw new Error(String(agent.error));
      const lanes = [...Array.from({ length: COPIES_PER_DAY }, (_, n) => `lane-${n}`), "lane-extra"];
      for (const lane of lanes) {
        const forked = await forkRepo(app, agent.value.user, getRepo(app.db, "alice", lane)!, `bee-${lane}`);
        if (!forked.ok) throw new Error(`agent fork of ${lane}: ${forked.error}`);
      }
    }, 120_000);

    test("deleting a copy makes no room: five made, one deleted, the next is refused", async () => {
      const kim = await person("kim");
      for (let n = 0; n < COPIES_PER_DAY; n++) {
        const forked = await forkRepo(app, kim, await source(`row-${n}`));
        expect(forked.ok).toBe(true);
      }
      const gone = await deleteRepo(app, kim, getRepo(app.db, "kim", "row-0")!);
      expect(gone.ok).toBe(true);
      expect(getRepo(app.db, "kim", "row-0")).toBeUndefined();
      const next = await forkRepo(app, kim, await source("row-extra"));
      expect(next.ok).toBe(false);
      if (!next.ok) expect(next.error).toBe("limit");
      const viaCopy = await makeItYours(app, kim, getRepo(app.db, "alice", "row-extra")!, { dryRun: false });
      expect(viaCopy.ok).toBe(false);
      if (!viaCopy.ok) expect(viaCopy.error.kind).toBe("limit");
    }, 120_000);

    test("two copies at once, one place left: exactly one is made", async () => {
      const jo = await person("jo");
      for (let n = 0; n < COPIES_PER_DAY - 1; n++) {
        const made = await makeItYours(app, jo, await source(`plot-${n}`), { dryRun: false });
        expect(made.ok).toBe(true);
      }
      const [a, b] = [await source("plot-a"), await source("plot-b")];
      const both = await Promise.all([
        makeItYours(app, jo, a, { dryRun: false }),
        makeItYours(app, jo, b, { dryRun: false }),
      ]);
      expect(both.filter((r) => r.ok)).toHaveLength(1);
      const refused = both.find((r) => !r.ok)!;
      if (!refused.ok) expect(refused.error.kind).toBe("limit");
      expect(
        app.db
          .query(`SELECT COUNT(*) AS n FROM repo WHERE owner_id = ?1 AND fork_parent_id IS NOT NULL`)
          .get(jo.id),
      ).toEqual({ n: COPIES_PER_DAY });
    }, 120_000);
  });
});
