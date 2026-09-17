/**
 * The global map: every app a person can see on one canvas, one lane per
 * repository with something to draw, where the crew is marked on it. A
 * lane is exactly the repository's own map, so what the per-repo page
 * says and what `/map` says never disagree.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import type { Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the global map", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let bob: User;
  let engine: Repo;
  const engineIssues: Issue[] = [];

  const signIn = async (username: string): Promise<string> =>
    (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username,
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  const person = async (username: string, admin = false): Promise<User> => {
    const made = await createUser(app.db, {
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: admin,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const repoOf = async (
    owner: User,
    name: string,
    titles: string[],
  ): Promise<{ repo: Repo; issues: Issue[] }> => {
    const made = await createRepo(app, owner, { name, visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const issues = titles.map((title) => {
      const opened = openIssue(app, owner, made.value, { title });
      if (!opened.ok) throw new Error(String(opened.error));
      return opened.value;
    });
    return { repo: made.value, issues };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-map-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    alice = await person("alice", true);
    bob = await person("bob");
    await person("carol");

    // alice/engine: three issues, 2 waits for 1, and the crew on 1.
    const made = await repoOf(alice, "engine", [
      "Extract renderer",
      "Scene graph",
      "Write the docs",
    ]);
    engine = made.repo;
    engineIssues.push(...made.issues);
    expect(
      addDependency(app.db, engineIssues[1]!, engineIssues[0]!, alice.id).ok,
    ).toBe(true);
    const scout = await createAgent(app, alice, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    expect(addToCrew(app, alice, engine, "scout").ok).toBe(true);
    const scoutUser = getUserByName(app.db, "scout")!;
    const assigned = assignIssue(
      app,
      alice,
      engine,
      engineIssues[0]!,
      scoutUser,
    );
    if (!assigned.ok) throw new Error(String(assigned.error));
    const run = createRun(app.db, {
      repoId: engine.id,
      kind: "agent",
      issueId: engineIssues[0]!.id,
      actorId: scoutUser.id,
      reason: "assigned",
    });
    expect(claimRun(app.db, run.id)).toBeDefined();

    // alice/bare: a repository with nothing open and nobody working.
    await repoOf(alice, "bare", []);
    // bob/secret: bob's own, which alice cannot see and bob can.
    await repoOf(bob, "secret", ["Rotate the keys"]);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a person sees a lane for each repository they can read, and no other", async () => {
    const cookie = await signIn("alice");
    const page = await (
      await fetch(`${base}/map`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
      })
    ).text();
    expect(page).toContain("<h1>Map</h1>");
    expect(page).toContain('href="/alice/engine/map"');
    expect(page).toContain("Extract renderer");
    expect(page).toContain("Scene graph");
    // The lane says how the repository runs itself and what is in flight.
    expect(page).toContain("off · 1 run in flight");
    // Where the crew is: the studio's word on the issue, and the dot.
    expect(page).toContain('data-run="running"');
    expect(page).toContain(">working</tspan");
    expect(page).toContain('class="map-crew-dot"');
    // A repository with nothing to draw is not a lane.
    expect(page).not.toContain('href="/alice/bare/map"');
    // The forge's admin reads every repository, so bob's is a lane here …
    expect(page).toContain('href="/bob/secret/map"');

    // … and bob, who is nobody's admin, sees his own and not alice's.
    const bobs = await (
      await fetch(`${base}/map`, { headers: { cookie: await signIn("bob") } })
    ).text();
    expect(bobs).toContain('href="/bob/secret/map"');
    expect(bobs).toContain("Rotate the keys");
    expect(bobs).not.toContain("alice/engine");
    expect(bobs).not.toContain("Extract renderer");

    // The per-repo map carries the same marker, so the two never disagree.
    const own = await (
      await fetch(`${base}/alice/engine/map`, { headers: { cookie } })
    ).text();
    expect(own).toContain('data-run="running"');
    expect(own).toContain(">working</tspan");
  });

  test("nothing to draw anywhere is one quiet sentence; a stranger is sent to sign in", async () => {
    const page = await (
      await fetch(`${base}/map`, { headers: { cookie: await signIn("carol") } })
    ).text();
    expect(page).toContain("Nothing to map");
    expect(page).not.toContain('class="map-lane"');
    expect(page).not.toContain("No open issues to map");

    const anonymous = await fetch(`${base}/map`, { redirect: "manual" });
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toContain("/signin");
  });

  test("the map is reached from the user menu and the palette on both homes", async () => {
    const cookie = await signIn("alice");
    for (const mode of ["studio", "dev"]) {
      const home = await (
        await fetch(`${base}/`, {
          headers: { cookie: `${cookie}; forge_mode=${mode}` },
        })
      ).text();
      expect(home).toContain('href="/map"');
      expect(home).toContain('"t":"Map","h":"/map"');
    }
  });

  test("the data has one entry per visible repository, with its issues and where the crew is", async () => {
    const token = createToken(app.db, alice.id, "test", "rw").token;
    const res = await fetch(`${base}/api/v1/map`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      repos: {
        repo: { owner: string; name: string };
        autonomy: string;
        spentTodayUsd: number | null;
        inFlight: number;
        issues: { number: number; title: string }[];
        ready: { number: number }[];
        working: number[];
        edges: { issue: number; blockedBy: number }[];
      }[];
    };
    const names = data.repos.map((r) => `${r.repo.owner}/${r.repo.name}`);
    expect(names).toContain("alice/engine");
    expect(names).toContain("bob/secret");
    expect(names).not.toContain("alice/bare");
    const lane = data.repos.find((r) => r.repo.name === "engine")!;
    expect(lane.issues.map((i) => i.number)).toEqual([1, 2, 3]);
    expect(lane.ready.map((r) => r.number)).toEqual([1, 3]);
    expect(lane.edges).toEqual([{ issue: 2, blockedBy: 1 }]);
    expect(lane.working).toEqual([1]);
    expect(lane.autonomy).toBe("off");
    expect(lane.spentTodayUsd).toBeNull();
    expect(lane.inFlight).toBe(1);

    // The per-repo data says the same about where the crew is.
    const own = (await (
      await fetch(`${base}/api/v1/repos/alice/engine/map`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { working: number[] };
    expect(own.working).toEqual([1]);

    // A stranger's token sees only what a stranger can: nothing private.
    const bobToken = createToken(app.db, bob.id, "test", "ro").token;
    const bobs = (await (
      await fetch(`${base}/api/v1/map`, {
        headers: { authorization: `Bearer ${bobToken}` },
      })
    ).json()) as { repos: { repo: { owner: string } }[] };
    expect(bobs.repos.map((r) => r.repo.owner)).toEqual(["bob"]);
  });
});
