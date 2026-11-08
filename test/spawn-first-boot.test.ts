/**
 * A spawned child's first boot (#575): the spawner's words become the
 * child's direction, opened once and handed to its planner; one claim link,
 * seen once by the spawner and kept by the child only as a hash, makes the
 * person who opens it the child's admin — once, within a day, from the
 * child's own pages — and a link that is used, expired or made up says so.
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import {
  childDirOf,
  spawnForge,
  type SpawnDeps,
} from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import {
  addCrew,
  createAgentRow,
  listCrewRoles,
  } from "../src/core/agents.ts";
import { listIssues } from "../src/core/issues.ts";
import { getOrg, listTeams, listTeamMembers } from "../src/core/orgs.ts";
import { getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, SHOWN_ONCE_NOTE, type Servers } from "../src/http/server.ts";
import { readClaim } from "../src/spawn/claim.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import type { SpawnSource } from "../src/spawn/plan.ts";
import { quietLogs } from "./helpers/globals.ts";
import { passkeyFields } from "./helpers/passkey.ts";

quietLogs();

const author = { name: "a", email: "a@x.invalid" };
const WORDS =
  "Run Maria's bakery: orders in the morning, a weekly menu, and a page her customers love.";

describe("a spawned child's first boot", () => {
  let dir = "";
  let parent: App;
  let alice: User;
  let child: App;
  let servers: Servers;
  let token = "";
  let claimUrl = "";
  let bodyId = "";

  const url = (path: string) => `${servers.url}${path}`;
  const claim = (
    t: string,
    form: Record<string, string>,
    origin: string | null = servers.url,
  ) =>
    fetch(url("/claim"), {
      method: "POST",
      headers: origin === null ? {} : { origin },
      body: new URLSearchParams({ token: t, ...form }),
      redirect: "manual",
    });
  /** What the page does: a passkey from `/claim/options`, then the form. */
  const claimWithKey = async (t: string, form: Record<string, string>) =>
    claim(t, { ...form, ...(await passkeyFields(servers.url, "/claim/options", { token: t, ...form })) });
  /** The link is still good: nothing claimed it yet. */
  const unspent = (t: string) =>
    readClaim(child.db, getOrg(child.db, "bakery")!.id, t).state === "ok";
  const maria = {
    username: "maria",
    email: "maria@bakery.test",
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-first-boot-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const made = await createUser(parent.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "a@x.invalid",
      isAdmin: true,
    });
    if (!made.ok) throw new Error("user");
    alice = made.value;
    const repo = await createRepo(parent, alice, { name: "bakery" });
    if (!repo.ok) throw new Error("repo");
    const c = await commitFiles(repoDir(parent.reposRoot, "alice", "bakery"), {
      branch: "main",
      message: "the bakery",
      files: [{ path: "README.md", content: "# bakery\n" }],
      author,
    });
    if (!c.ok) throw new Error("commit");
    // The parent's crew on the app: atlas plans, scout builds.
    for (const [name, role] of [
      ["atlas", "planner"],
      ["scout", "builder"],
    ] as const) {
      const agent = await createUser(parent.db, { origin: "seed", trusted: true,
        username: name,
        email: `${name}@agents.invalid`,
        agent: true,
      });
      if (!agent.ok) throw new Error("agent");
      createAgentRow(parent.db, {
        userId: agent.value.id,
        brief: `${name}'s brief`,
        createdBy: alice.id,
      });
      addCrew(parent.db, repo.value.id, agent.value.id, alice.id);
      seatAs(parent.db, repo.value.id, agent.value.id, role);
    }
    const source: SpawnSource = {
      catalog: [
        { ref: "alice/bakery", readable: true, bytes: 10, forgeJsonBytes: 0 },
      ],
      briefs: [
        { agent: "atlas", text: "atlas's brief" },
        { agent: "scout", text: "scout's brief" },
      ],
      subscriptions: [],
    };
    const deps: SpawnDeps = {
      placement: hostedPlacement({ host: "forge.test" }),
      request: new Request("https://forge.test/x", {
        method: "POST",
        headers: { origin: "https://forge.test" },
      }),
      url: new URL("https://forge.test/x"),
    };
    const spawned = await spawnForge(
      parent,
      alice,
      {
        name: "maria",
        org: "bakery",
        apps: ["alice/bakery"],
        carryBriefs: true,
        carrySubscriptions: false,
        direction: WORDS,
      },
      source,
      deps,
    );
    if (!spawned.ok) throw new Error(JSON.stringify(spawned.error));
    bodyId = spawned.value.bodyId;
    claimUrl = spawned.value.claimUrl ?? "";
    token = claimUrl.split("/claim#")[1] ?? "";

    child = createApp({ dataDir: childDirOf(parent, bodyId), port: 0 });
    await firstBoot(child);
    servers = await serve(child);
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    child.close();
    parent.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the spawner sees one claim link; neither forge keeps it in the clear", async () => {
    expect(claimUrl).toMatch(
      /^https:\/\/maria--forge\.test\/claim#[A-Za-z0-9_-]{43}$/,
    );
    let everything = "";
    for (const root of [join(dir, "spawn"), childDirOf(parent, bodyId)])
      for (const e of await readdir(root, {
        recursive: true,
        withFileTypes: true,
      }))
        if (e.isFile())
          everything += await Bun.file(join(e.parentPath, e.name))
            .text()
            .catch(() => "");
    expect(everything).not.toContain(token);
  });

  test("asked again, the spawner is not shown a link a second time", async () => {
    const again = await spawnForge(
      parent,
      alice,
      {
        name: "maria",
        org: "bakery",
        apps: ["alice/bakery"],
        carryBriefs: true,
        carrySubscriptions: false,
        direction: WORDS,
      },
      {
        catalog: [
          { ref: "alice/bakery", readable: true, bytes: 10, forgeJsonBytes: 0 },
        ],
        briefs: [
          { agent: "atlas", text: "atlas's brief" },
          { agent: "scout", text: "scout's brief" },
        ],
        subscriptions: [],
      },
      {
        placement: hostedPlacement({ host: "forge.test" }),
        request: new Request("https://forge.test/x", {
          method: "POST",
          headers: { origin: "https://forge.test" },
        }),
        url: new URL("https://forge.test/x"),
      },
    );
    if (!again.ok) throw new Error(JSON.stringify(again.error));
    expect(again.value.existed).toBe(true);
    expect(again.value.claimUrl).toBeUndefined();
  });

  test("the first boot opens the direction once, from the spawner's words, for the planner", async () => {
    const repo = getRepo(child.db, "bakery", "bakery")!;
    expect(repo.autonomyDirection).toBe(WORDS);
    expect(
      listCrewRoles(child.db, repo.id)
        .map((c) => [c.agent.user.username, c.role])
        .sort(),
    ).toEqual([
      ["atlas", "planner"],
      ["scout", "builder"],
    ]);
    const issues = listIssues(child.db, repo.id, { state: "all" });
    expect(issues.length).toBe(1);
    expect(issues[0]!.body).toContain(WORDS);
    expect(issues[0]!.assigneeName).toBe("atlas");
    expect(repo.directionIssueId).toBe(issues[0]!.id);
    // A second boot — a restart — opens nothing more.
    await firstBoot(child);
    expect(listIssues(child.db, repo.id, { state: "all" }).length).toBe(1);
  });

  test("the child answers /healthz and / quickly once booted", async () => {
    for (const path of ["/healthz", "/"]) {
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const res = await fetch(url(path), { redirect: "manual" });
        await res.arrayBuffer();
        times.push(performance.now() - t0);
        expect(res.status).toBeLessThan(400);
      }
      times.sort((a, b) => a - b);
      // What this guards against is a boot per request, which is seconds; a
      // loaded runner's loopback round trip is tens of milliseconds.
      expect(times[2]!).toBeLessThan(500);
    }
  });

  test("a made-up code says it is not a claim link", async () => {
    const res = await claim("x".repeat(43), maria);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not a claim link");
    expect(getUserByName(child.db, "maria")).toBeUndefined();
  });

  test("the old path form is gone: /claim/<anything> is a 404 and spends nothing", async () => {
    for (const t of [token, "x".repeat(43)]) {
      expect((await fetch(url(`/claim/${t}`))).status).toBe(404);
      const res = await fetch(url(`/claim/${t}`), {
        method: "POST",
        headers: { origin: servers.url },
        body: new URLSearchParams(maria),
        redirect: "manual",
      });
      expect(res.status).toBe(404);
    }
    expect(getUserByName(child.db, "maria")).toBeUndefined();
    expect(unspent(token)).toBe(true);
  });

  test("the link opens a page that asks before it acts: a GET claims nothing", async () => {
    const page = await fetch(url("/claim"));
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain("This forge is yours");
    // Plain about who can see it, before anyone submits.
    expect(text.replace(/\s+/g, " ")).toContain(
      "alice, who made it, no longer has access unless you invite them back",
    );
    expect(getUserByName(child.db, "maria")).toBeUndefined();
  });

  test("a post from another origin is refused, and the link still works", async () => {
    const res = await claim(token, maria, "https://evil.test");
    expect(res.status).toBe(403);
    expect(getUserByName(child.db, "maria")).toBeUndefined();
    expect(unspent(token)).toBe(true);
  });

  test("a password too short is refused, and the link is not spent on it", async () => {
    const res = await claim(token, { ...maria, password: "short" });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Passwords need at least 12 characters.");
    expect(getUserByName(child.db, "maria")).toBeUndefined();
    expect(unspent(token)).toBe(true);
  });

  test("claiming makes the person the child's admin and an owner of its organisation, signed in", async () => {
    const res = await claimWithKey(token, maria);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("forge_session=");
    expect(cookie).toContain("HttpOnly");
    const user = getUserByName(child.db, "maria")!;
    expect(user.isAdmin).toBe(true);
    const org = getOrg(child.db, "bakery")!;
    const owners = listTeams(child.db, org.id).find(
      (t) => t.permission === "admin",
    )!;
    expect(
      listTeamMembers(child.db, owners.id).map((u) => u.username),
    ).toContain("maria");
    // The session works: the home answers as maria.
    const home = await fetch(url("/"), {
      headers: { cookie: cookie.split(";")[0]! },
    });
    expect(await home.text()).toContain("maria");
  });

  test("by default the spawner's account leaves: it cannot open the child's private pages", async () => {
    const founder = getUserByName(child.db, "alice")!;
    const org = getOrg(child.db, "bakery")!;
    const owners = listTeams(child.db, org.id).find((t) => t.name === "Owners")!;
    expect(listTeamMembers(child.db, owners.id).map((u) => u.username)).toEqual(["maria"]);
    expect(founder.isAdmin).toBe(false);
    // The spawner's identity, signed in (a session, or the edge mapping its
    // login to this account), sees the private app as if it did not exist.
    const { createSession } = await import("../src/core/sessions.ts");
    const session = createSession(child.db, founder.id);
    const res = await fetch(url("/bakery/bakery"), {
      headers: { cookie: `forge_session=${session.token}` },
    });
    expect(res.status).toBe(404);
  });

  test("a used link says so, and claims nothing a second time", async () => {
    const res = await claim(token, {
      ...maria,
      username: "mallory",
      email: "m@evil.test",
    });
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("already been used");
    expect(getUserByName(child.db, "mallory")).toBeUndefined();
  });

  test("an expired link says so", async () => {
    // A second child, its link a day and a minute old.
    const { mintClaim } = await import("../src/spawn/claim.ts");
    const org = getOrg(child.db, "bakery")!;
    const old = mintClaim(
      child.db,
      org.id,
      Date.now() - 24 * 60 * 60 * 1000 - 60_000,
    );
    const res = await claim(old, {
      ...maria,
      username: "late",
      email: "late@x.test",
    });
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("expired");
    expect(getUserByName(child.db, "late")).toBeUndefined();
  });

});

describe("claims are bound to a spawned forge, and the link is shown once", () => {
  let dir = "";
  let parent: App;
  let servers: Servers;
  let rw = "";
  let kidDir = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-claim-bound-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const made = await createUser(parent.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.invalid", password: "a-long-passphrase-1", isAdmin: true });
    if (!made.ok) throw new Error("user");
    const repo = await createRepo(parent, made.value, { name: "bakery" });
    if (!repo.ok) throw new Error("repo");
    const c = await commitFiles(repoDir(parent.reposRoot, "alice", "bakery"), {
      branch: "main",
      message: "the bakery",
      files: [{ path: "README.md", content: "# bakery\n" }],
      author,
    });
    if (!c.ok) throw new Error("commit");
    rw = createToken(parent.db, made.value.id, "rw", "rw").token;
    servers = await serve(parent);
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    parent.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("a forge that was not spawned has no claim page, even with a crafted row", async () => {
    const { mintClaim } = await import("../src/spawn/claim.ts");
    const alice = getUserByName(parent.db, "alice")!;
    const crafted = mintClaim(parent.db, alice.id);
    const page = await fetch(`${servers.url}/claim`);
    expect(page.status).toBe(404);
    const res = await fetch(`${servers.url}/claim`, {
      method: "POST",
      headers: { origin: "https://forge.test" },
      body: new URLSearchParams({ token: crafted, username: "mallory", email: "m@evil.test" }),
      redirect: "manual",
    });
    expect(res.status).toBe(404);
    expect(getUserByName(parent.db, "mallory")).toBeUndefined();
  });

  test("an idempotent spawn keeps no claim link: the replay says it was shown once", async () => {
    const send = () =>
      fetch(`${servers.url}/api/v1/forges`, {
        method: "POST",
        headers: { authorization: `Bearer ${rw}`, "content-type": "application/json", "idempotency-key": "kai-1" },
        body: JSON.stringify({ name: "kai", apps: ["alice/bakery"], dryRun: false, keepAccess: true }),
      });
    const first = await send();
    expect(first.status).toBe(201);
    const made = (await first.json()) as { claimUrl: string; bodyId: string };
    const token = made.claimUrl.split("/claim#")[1]!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = parent.db.query("SELECT body FROM idempotency").all() as { body: string }[];
    expect(stored.length).toBe(1);
    expect(stored[0]!.body).not.toContain(token);
    const again = await send();
    const replayed = (await again.json()) as { claimUrl: string };
    expect(replayed.claimUrl).toBe(SHOWN_ONCE_NOTE);
    kidDir = childDirOf(parent, made.bodyId);
    // Keep the token for the next test.
    (globalThis as { kaiToken?: string }).kaiToken = token;
  });

  test("a spawner who keeps access is named on the claim page, and stays an owner", async () => {
    const token = (globalThis as { kaiToken?: string }).kaiToken!;
    const kid = createApp({ dataDir: kidDir, port: 0 });
    await firstBoot(kid);
    const kidServers = await serve(kid);
    try {
      const page = (await (await fetch(`${kidServers.url}/claim`)).text()).replace(/\s+/g, " ");
      expect(page).toContain("alice keeps owner access to this forge; you can remove it in your organisation");
      // A username and a password, no email: the first admin, signed in.
      const res = await fetch(`${kidServers.url}/claim`, {
        method: "POST",
        headers: { origin: kidServers.url },
        body: new URLSearchParams({ token, username: "kai-owner", password: "a-long-kai-passphrase" }),
        redirect: "manual",
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("set-cookie") ?? "").toContain("forge_session=");
      const admin = getUserByName(kid.db, "kai-owner")!;
      expect(admin.isAdmin).toBe(true);
      expect(admin.email).toBe("kai-owner@no-email.invalid");
      const org = getOrg(kid.db, "kai")!;
      const owners = listTeams(kid.db, org.id).find((t) => t.name === "Owners")!;
      expect(listTeamMembers(kid.db, owners.id).map((u) => u.username).sort()).toEqual(["alice", "kai-owner"]);
      // A crafted row on any other account of the child is never consulted.
      const { mintClaim } = await import("../src/spawn/claim.ts");
      const other = mintClaim(kid.db, getUserByName(kid.db, "alice")!.id);
      const crafted = await fetch(`${kidServers.url}/claim`, {
        method: "POST",
        headers: { origin: kidServers.url },
        body: new URLSearchParams({ token: other, username: "mallory", email: "m@evil.test" }),
        redirect: "manual",
      });
      expect(crafted.status).toBe(404);
      expect(getUserByName(kid.db, "mallory")).toBeUndefined();
    } finally {
      kidServers.stop();
      kid.close();
    }
  });
});
