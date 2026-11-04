/**
 * Preview now (`actions/build_preview.ts`): a writer asks for any commit of
 * an app and it runs at `<slug>--b<sha7>` with a copy of production's data.
 * Asking twice is one environment, a fourth takes the oldest's place, and a
 * reader, an agent, a mirror, a repository that is no app and anything that
 * is not a commit here are refused. The host parser reads the new label back
 * without losing previews or a hosted forge's own apps.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { BUILD_ASKS_MAX, previewBuild } from "../src/actions/build_preview.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { buildEnv, envWords } from "../src/apps/data.ts";
import { parseAppHost } from "../src/apps/proxy.ts";
import { parseAppLogin } from "../src/apps/tty.ts";
import { AppsRuntime, BUILD_PREVIEWS_MAX, type EnvStatus } from "../src/apps/runtime.ts";
import { isSlug, slugFor, type AppRecord } from "../src/core/apps.ts";
import { listEvents } from "../src/core/events.ts";
import { createOrigin, linkRepoToOrigin } from "../src/core/origins.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const DOMAIN = "apps.test";

/** Says which commit and environment it is, and what production left in its data. */
const SERVER = `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const data = process.env.FORGE_APP_DATA ?? ".";
const seed = join(data, "seed.txt");
if (process.env.FORGE_APP_ENV === "production" && !existsSync(seed))
  writeFileSync(seed, "written by production");
Bun.serve({
  port: Number(process.env.PORT ?? "0"),
  hostname: "127.0.0.1",
  fetch: () =>
    new Response(
      [
        process.env.FORGE_APP_COMMIT,
        process.env.FORGE_APP_URL,
        existsSync(seed) ? readFileSync(seed, "utf8") : "no data",
      ].join("\\n"),
    ),
});
`;

describe("build preview hosts", () => {
  test("<slug>--b<sha7> reads back as the build, and the old forms still read", () => {
    expect(parseAppHost(`show--b1a2b3c4.${DOMAIN}`, DOMAIN)).toEqual({
      slug: "show",
      env: "build-1a2b3c4",
      nested: false,
    });
    // Hostnames are case-insensitive; the env name is not.
    expect(parseAppHost(`Show--B1A2B3C4.${DOMAIN}:3000`, DOMAIN)?.env).toBe("build-1a2b3c4");
    // A forge hosted in a build preview keeps its own apps in front of ours.
    expect(parseAppHost(`notes--show--b1a2b3c4.${DOMAIN}`, DOMAIN)).toEqual({
      slug: "show",
      env: "build-1a2b3c4",
      nested: true,
    });
    // A guest's build preview under our app is the guest's to route.
    expect(parseAppHost(`notes--b1a2b3c4--show.${DOMAIN}`, DOMAIN)).toEqual({
      slug: "show",
      env: "production",
      nested: true,
    });
    // Not seven hex digits after `b`: not a build, so the tail is a slug.
    expect(parseAppHost(`show--b1a2b3c.${DOMAIN}`, DOMAIN)?.env).toBe("production");
    expect(parseAppHost(`show--b1a2b3cz.${DOMAIN}`, DOMAIN)?.env).toBe("production");
    expect(parseAppHost(`show--b1a2b3c4d.${DOMAIN}`, DOMAIN)?.env).toBe("production");
    // Previews and production as they were.
    expect(parseAppHost(`show--3.${DOMAIN}`, DOMAIN)?.env).toBe("pull-3");
    expect(parseAppHost(`cs--3--lab--14.${DOMAIN}`, DOMAIN)).toEqual({
      slug: "lab",
      env: "pull-14",
      nested: true,
    });
    expect(parseAppHost(`show.${DOMAIN}`, DOMAIN)?.env).toBe("production");
    // The single-label attachment works for builds too.
    expect(parseAppHost("show--b1a2b3c4--forge.example", "--forge.example")).toEqual({
      slug: "show",
      env: "build-1a2b3c4",
      nested: false,
    });
    expect(parseAppLogin("show--b1a2b3c4")).toEqual({ slug: "show", env: "build-1a2b3c4" });
    expect(buildEnv("1A2B3C4D5E")).toBe("build-1a2b3c4");
    expect(envWords("build-1a2b3c4")).toBe("the build at 1a2b3c4");
  });

  test("a build-shaped slug is reserved", () => {
    expect(isSlug("b1a2b3c4")).toBe(false);
    expect(slugFor("b1a2b3c4")).toBe("b1a2b3c4-app");
    expect(isSlug("b1a2b3c")).toBe(true);
    expect(isSlug("build")).toBe(true);
  });
});

describe("preview now", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let record: AppRecord;
  const commits: string[] = [];
  let aliceToken = "";
  let bobToken = "";

  const viaHost = (host: string, path = "/") =>
    fetch(`${servers.url}${path}`, { headers: { host }, redirect: "manual" });

  const api = (method: string, path: string, token: string, body?: unknown) =>
    fetch(`${servers.url}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  async function until<T>(read: () => T | undefined, ms = 60_000): Promise<T> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = read();
      if (value !== undefined) return value;
      await Bun.sleep(50);
    }
    throw new Error("did not happen in time");
  }

  const settled = (where: (run: Run) => boolean): Promise<Run> =>
    until(() =>
      listRuns(app.db, repo.id, { kind: "deploy", limit: 50 }).find(
        (r) =>
          where(r) &&
          (r.state === "ok" || r.state === "failed" || r.state === "cancelled"),
      ),
    );

  const builds = (): EnvStatus[] =>
    runtime.status(record).filter((e) => e.env.startsWith("build-"));

  const bare = () => repoDir(app.reposRoot, repo.ownerName, repo.name);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-build-preview-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
    });
    await runtime.start();
    const a = await createUser(app.db, { origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    aliceToken = createToken(app.db, alice.id, "test", "rw").token;
    bobToken = createToken(app.db, bob.id, "test", "rw").token;

    const made = await createRepo(app, alice, { name: "show", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const c1 = await commitToBranch(app, alice, repo, {
      message: "a build worth seeing",
      files: [
        {
          path: "package.json",
          content: JSON.stringify({ name: "show", scripts: { start: "bun server.ts" } }),
        },
        { path: "server.ts", content: SERVER },
      ],
    });
    if (!c1.ok) throw new Error(JSON.stringify(c1.error));
    commits.push(c1.value.commitOid);
    // More builds on a side branch, so production stays where it is.
    for (const n of [2, 3, 4, 5]) {
      const c = await commitToBranch(app, alice, repo, {
        branch: "side",
        base: n === 2 ? "main" : "side",
        message: `build ${n}`,
        files: [{ path: `NOTE${n}.md`, content: `${n}\n` }],
      });
      if (!c.ok) throw new Error(JSON.stringify(c.error));
      commits.push(c.value.commitOid);
    }
    const enabled = enableApp(app, alice, repo, {});
    if (!enabled.ok) throw new Error(enabled.error);
    record = enabled.value;
    const production = await settled((r) => r.env === "production");
    if (production.state !== "ok") throw new Error(production.summary);
  }, 90_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a reader, an agent and nobody are refused", async () => {
    const sha = commits[1]!;
    const response = await api("POST", "/repos/alice/show/builds/preview", bobToken, { sha });
    expect(response.status).toBe(403);
    const reader = await previewBuild(app, bob, repo, sha);
    expect(reader.ok ? undefined : reader.error).toBe("forbidden");
    const anonymous = await previewBuild(app, undefined, repo, sha);
    expect(anonymous.ok ? undefined : anonymous.error).toBe("unauthorized");

    const made = await createAgent(app, alice, { username: "scout", brief: "I ship." });
    if (!made.ok) throw new Error(String(made.error));
    expect(addToCrew(app, alice, repo, "scout").ok).toBe(true);
    const scout = getUserByName(app.db, "scout")!;
    const agent = await previewBuild(app, scout, repo, sha);
    expect(agent.ok ? undefined : agent.error).toBe("forbidden");

    expect(builds()).toEqual([]);
    expect(listEvents(app.db, { kind: "app.build_preview" })).toEqual([]);
  });

  test("anything that is not a commit here is refused", async () => {
    const tree = Bun.spawnSync(["git", "rev-parse", `${commits[0]}^{tree}`], {
      cwd: bare(),
      env: gitClientEnv(),
    })
      .stdout.toString()
      .trim();
    for (const sha of [tree, "0".repeat(40), commits[0]!.slice(0, 7), "--upload-pack=x", ""]) {
      const response = await api("POST", "/repos/alice/show/builds/preview", aliceToken, { sha });
      expect(response.status).toBe(422);
      expect(((await response.json()) as { error: string }).error).toBe("not_a_commit");
    }
    expect(builds()).toEqual([]);
  });

  test("a repository that is no app, and a mirror, are refused", async () => {
    const plain = await createRepo(app, alice, { name: "plain", visibility: "public" });
    if (!plain.ok) throw new Error(String(plain.error));
    const p = await commitToBranch(app, alice, plain.value, {
      message: "seed",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!p.ok) throw new Error(JSON.stringify(p.error));
    const notApp = await previewBuild(app, alice, plain.value, p.value.commitOid);
    expect(notApp.ok ? undefined : notApp.error).toBe("not_found");
    const response = await api("POST", "/repos/alice/plain/builds/preview", aliceToken, {
      sha: p.value.commitOid,
    });
    expect(response.status).toBe(404);

    const made = await createRepo(app, alice, { name: "mirrored", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const c = await commitToBranch(app, alice, made.value, {
      message: "seed",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const origin = createOrigin(app.db, dataDir, {
      userId: alice.id,
      kind: "github",
      apiUrl: "https://api.github.invalid",
      webUrl: "https://github.invalid",
      login: "alice",
      token: "not-a-real-token",
    });
    if (!origin.ok) throw new Error(origin.error);
    linkRepoToOrigin(app.db, made.value.id, {
      originId: origin.value.id,
      fullName: "alice/mirrored",
      remoteId: "1",
      htmlUrl: "https://github.invalid/alice/mirrored",
    });
    const mirrored = await previewBuild(app, alice, made.value, c.value.commitOid);
    expect(mirrored.ok ? undefined : mirrored.error).toBe("mirrored");
    const viaApi = await api("POST", "/repos/alice/mirrored/builds/preview", aliceToken, {
      sha: c.value.commitOid,
    });
    expect(viaApi.status).toBe(422);
    expect(((await viaApi.json()) as { error: string }).error).toBe("mirrored");
  });

  test("a writer previews a commit: it runs at <slug>--b<sha7>, with production's data copied", async () => {
    const sha = commits[1]!;
    const short = sha.slice(0, 7);
    const response = await api("POST", "/repos/alice/show/builds/preview", aliceToken, { sha });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { env: string; url: string };
    expect(body.env).toBe(`build-${short}`);
    expect(body.url).toBe(`http://show--b${short}.${DOMAIN}:${servers.port}`);

    const run = await settled((r) => r.env === `build-${short}` && r.commitOid === sha);
    expect(run.state).toBe("ok");
    const status = builds()[0];
    expect(status?.env).toBe(`build-${short}`);
    expect(status?.state).toBe("running");
    expect(status?.commitOid).toBe(sha);
    expect(status?.url).toBe(body.url);
    expect(runtime.status(record).map((e) => e.env)).toEqual(["production", `build-${short}`]);

    const page = await (await viaHost(`show--b${short}.${DOMAIN}`)).text();
    expect(page).toContain(sha);
    expect(page).toContain(`show--b${short}.${DOMAIN}`);
    expect(page).toContain("written by production");
    // Production still serves the default branch.
    expect(await (await viaHost(`show.${DOMAIN}`)).text()).toContain(commits[0]!);

    const events = listEvents(app.db, { kind: "app.build_preview" });
    expect(events[0]?.payload["oid"]).toBe(sha);
  }, 90_000);

  test("the same commit twice is one environment, and nothing redeploys", async () => {
    const sha = commits[1]!;
    const deploys = () =>
      listRuns(app.db, repo.id, { kind: "deploy", limit: 50 }).filter(
        (r) => r.env === `build-${sha.slice(0, 7)}`,
      ).length;
    const before = deploys();
    const again = await previewBuild(app, alice, repo, sha);
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.value.env).toBe(`build-${sha.slice(0, 7)}`);
      expect(again.value.run).toBeUndefined();
    }
    // The API door answers with the environment and where it is served.
    const door = await fetch(`${servers.url}/api/v1/repos/alice/show/builds/preview`, {
      method: "POST",
      headers: { authorization: `Bearer ${aliceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ sha }),
    });
    expect(door.status).toBe(201);
    const said = (await door.json()) as { env: string; url: string };
    expect(said.env).toBe(`build-${sha.slice(0, 7)}`);
    expect(said.url).toContain(`show--b${sha.slice(0, 7)}.${DOMAIN}`);
    const refused = await fetch(`${servers.url}/api/v1/repos/alice/show/builds/preview`, {
      method: "POST",
      headers: { authorization: `Bearer ${aliceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ sha: "not-a-sha" }),
    });
    expect(refused.status).toBe(422);
    expect(deploys()).toBe(before);
    expect(builds().length).toBe(1);
  });

  test(`a build beyond ${BUILD_PREVIEWS_MAX} takes the oldest's place`, async () => {
    const [, oldest, b, c, d] = commits as [string, string, string, string, string];
    for (const sha of [b, c]) {
      const asked = await previewBuild(app, alice, repo, sha);
      expect(asked.ok).toBe(true);
    }
    expect(builds().map((e): string => e.env).sort()).toEqual(
      [oldest, b, c].map((s) => `build-${s.slice(0, 7)}`).sort(),
    );
    const fourth = await previewBuild(app, alice, repo, d);
    expect(fourth.ok).toBe(true);
    expect(builds().map((e): string => e.env).sort()).toEqual(
      [b, c, d].map((s) => `build-${s.slice(0, 7)}`).sort(),
    );
    // The oldest is gone, page and all.
    const gone = await viaHost(`show--b${oldest.slice(0, 7)}.${DOMAIN}`);
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain("the build at");
    const run = await settled((r) => r.env === `build-${d.slice(0, 7)}` && r.commitOid === d);
    expect(run.state).toBe("ok");
    expect(await (await viaHost(`show--b${d.slice(0, 7)}.${DOMAIN}`)).text()).toContain(d);
  }, 120_000);

  test("the forge coming back does not rebuild a build preview", async () => {
    await runtime.stop();
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
    });
    await runtime.start();
    expect(builds()).toEqual([]);
    expect(runtime.status(record).map((e) => e.env)).toEqual(["production"]);
  }, 60_000);

  test(`a person may ask ${BUILD_ASKS_MAX} times per app, then is told to wait`, async () => {
    const sha = commits[1]!;
    let last = await previewBuild(app, alice, repo, sha);
    for (let k = 0; k < BUILD_ASKS_MAX && last.ok; k++) last = await previewBuild(app, alice, repo, sha);
    expect(last.ok ? undefined : last.error).toBe("rate_limited");
    const door = await api("POST", "/repos/alice/show/builds/preview", aliceToken, { sha });
    expect(door.status).toBe(429);
  });

});
