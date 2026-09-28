/**
 * Migrate, end to end: a repository brought here for good.
 *
 * The fixture is a real repository on a real forge — several branches, a
 * lightweight and an annotated tag, a default branch that is not `main` —
 * and the migration speaks real smart HTTP to it. What must hold: the whole
 * history arrives (`git log --all` matches, every ref matches), the new
 * repository is native (no origin, no remote configured, pushes land here
 * and nowhere else), a refusal is words before anything exists, a failed
 * clone leaves nothing behind, and a crew put on it is on it: on the crew,
 * the repository an app, one issue carrying the importer's brief.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { migrateRepo, migrateUrl } from "../src/actions/migrate.ts";
import { resetConnectLimit } from "../src/actions/origins.ts";
import { createAgent, listCrew } from "../src/actions/crew.ts";
import {
  commitToBranch,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { listIssues } from "../src/core/issues.ts";
import { listOrigins } from "../src/core/origins.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { settled } from "../src/origins/jobs.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-migrate-passphrase";
const UPSTREAM_LOGIN = "octo";
const UPSTREAM_SECRET = "octo-upstream-secret-7c1d";

const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

async function git(args: string[], cwd: string) {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: gitClientEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

/** Every commit reachable from any ref, as a sorted list. */
async function allCommits(dir: string): Promise<string[]> {
  return (await git(["log", "--all", "--format=%H"], dir)).out
    .split("\n")
    .sort();
}

/** Every branch and tag with the object it names. */
async function allRefs(dir: string): Promise<string> {
  return (
    await git(
      [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads",
        "refs/tags",
      ],
      dir,
    )
  ).out;
}

describe("migrate", () => {
  let dataDir: string;
  let upstreamDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let upstream: App;
  let upstreamServers: Servers;
  let forgejo: FakeForge;
  let base: string;
  let alice: User;
  let bob: User;
  let aliceCookie = "";
  let bobCookie = "";
  let fixture: Repo;
  let fixtureUrl = "";

  const signUp = async (username: string): Promise<string> => {
    const response = await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        username,
        email: `${username}@forge.test`,
        password: PASSWORD,
      }),
      redirect: "manual",
    });
    return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  const browser = (
    cookie: string,
    path: string,
    form?: Record<string, string>,
    origin?: string,
  ): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: form === undefined ? "GET" : "POST",
      headers: {
        cookie,
        ...(form === undefined
          ? {}
          : { origin: origin ?? new URL(base).origin }),
      },
      redirect: "manual",
      ...(form === undefined ? {} : { body: new URLSearchParams(form) }),
    });

  const api = (
    user: string,
    path: string,
    payload: unknown,
  ): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basic(user, PASSWORD),
      },
      body: JSON.stringify(payload),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-migrate-"));
    upstreamDir = await mkdtemp(join(tmpdir(), "forge-migrate-up-"));
    work = await mkdtemp(join(tmpdir(), "forge-migrate-work-"));
    // The fixture's source is the forge itself, on loopback: a private host,
    // which a personal forge may say is fine.
    app = createApp({ dataDir, port: 0, migrateFromPrivateHosts: true });
    servers = await serve(app);
    base = servers.url;
    aliceCookie = await signUp("alice");
    bobCookie = await signUp("bob");
    alice = getUserByName(app.db, "alice")!;
    bob = getUserByName(app.db, "bob")!;

    // The fixture: alice's public repository with three branches, two tags
    // (one annotated), and `trunk` as its default — not the forge's `main`.
    const made = await createRepo(app, alice, {
      name: "fixture",
      visibility: "public",
    });
    if (!made.ok) throw new Error(made.error);
    fixture = made.value;
    const commit = async (branch: string, path: string, message: string) => {
      const done = await commitToBranch(app, alice, fixture, {
        branch,
        message,
        files: [{ path, content: `${message}\n` }],
      });
      if (!done.ok) throw new Error(String(done.error));
      return done.value;
    };
    await commit("main", "README.md", "first");
    await commit("main", "a.txt", "second");
    await commit("trunk", "trunk.txt", "on trunk");
    await commit("feature", "feature.txt", "a feature");
    await commit("feature", "feature2.txt", "more feature");
    const settings = await updateRepoSettings(app, alice, fixture, {
      defaultBranch: "trunk",
    });
    if (!settings.ok) throw new Error(settings.error);
    fixture = settings.value;
    const dir = repoDir(app.reposRoot, "alice", "fixture");
    expect((await git(["tag", "v1", "main~1"], dir)).code).toBe(0);
    expect(
      (await git(["tag", "-a", "v2", "-m", "the second", "feature"], dir)).code,
    ).toBe(0);
    fixtureUrl = `${base}/alice/fixture.git`;

    // A second forge holding a *private* repository, behind a fake origin
    // whose clone URL points at it: only the origin's credential opens it.
    upstream = createApp({ dataDir: upstreamDir, port: 0 });
    upstreamServers = await serve(upstream);
    await fetch(`${upstreamServers.url}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: UPSTREAM_LOGIN,
        email: "octo@upstream.test",
        password: UPSTREAM_SECRET,
      }),
    });
    const auth = { authorization: basic(UPSTREAM_LOGIN, UPSTREAM_SECRET) };
    await fetch(`${upstreamServers.url}/api/v1/repos`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ name: "secret-widgets", visibility: "private" }),
    });
    await fetch(
      `${upstreamServers.url}/api/v1/repos/octo/secret-widgets/contents`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({
          branch: "main",
          message: "first",
          files: [{ path: "README.md", content: "# widgets\n" }],
        }),
      },
    );
    const state = newFakeState("forgejo", UPSTREAM_LOGIN, UPSTREAM_SECRET);
    state.repos.push({
      id: 77,
      fullName: "octo/secret-widgets",
      description: "gears, privately",
      cloneUrl: `${upstreamServers.url}/octo/secret-widgets.git`,
      htmlUrl: `${upstreamServers.url}/octo/secret-widgets`,
      defaultBranch: "main",
      private: true,
    });
    forgejo = serveFakeForge(state);
    resetConnectLimit();
    forgetProviders(dataDir);
  });

  afterAll(async () => {
    forgejo.stop();
    servers.stop();
    upstreamServers.stop();
    app.close();
    upstream.close();
    forgetProviders(dataDir);
    for (const dir of [dataDir, upstreamDir, work])
      await rm(dir, { recursive: true, force: true });
  });

  test("by URL: the whole history arrives in a native repository, and pushes stay here", async () => {
    const sourceDir = repoDir(app.reposRoot, "alice", "fixture");
    const sourceRefs = await allRefs(sourceDir);

    const response = await api("bob", "/api/v1/migrate", {
      source: { url: fixtureUrl },
    });
    expect(response.status).toBe(202);
    const started = (await response.json()) as {
      repo: { full_name?: string; name: string };
      job: { id: string; stage: string };
    };
    expect(started.repo.name).toBe("fixture");
    const job = await settled(started.job.id);
    expect(job?.error).toBeUndefined();
    expect(job?.stage).toBe("done");
    expect(job?.detail).toContain("3 branches, 2 tags");

    const migrated = getRepo(app.db, "bob", "fixture")!;
    const dir = repoDir(app.reposRoot, "bob", "fixture");
    // Every commit, every branch, every tag — the annotated one as itself.
    expect(await allCommits(dir)).toEqual(await allCommits(sourceDir));
    expect(await allRefs(dir)).toBe(sourceRefs);
    expect((await git(["cat-file", "-t", "refs/tags/v2"], dir)).out).toBe(
      "tag",
    );
    // The source's default branch is kept.
    expect(migrated.defaultBranch).toBe("trunk");
    expect((await git(["symbolic-ref", "HEAD"], dir)).out).toBe(
      "refs/heads/trunk",
    );
    // Native: no origin row, no remote in its config — nothing to write through to.
    expect(migrated.origin).toBeNull();
    expect((await git(["config", "--get-regexp", "^remote\\."], dir)).out).toBe(
      "",
    );

    // A real push lands here, and the source never hears of it.
    const clone = join(work, "bob-fixture");
    const url = new URL(`${base}/bob/fixture.git`);
    url.username = "bob";
    url.password = PASSWORD;
    expect(
      (await git(["clone", "--quiet", url.toString(), clone], work)).code,
    ).toBe(0);
    await Bun.write(join(clone, "bob.txt"), "mine now\n");
    expect((await git(["add", "."], clone)).code).toBe(0);
    expect((await git(["commit", "-qm", "bob's change"], clone)).code).toBe(0);
    const pushed = await git(
      ["push", "--quiet", "origin", "HEAD:refs/heads/bobs"],
      clone,
    );
    expect(pushed.err).toBe("");
    expect(pushed.code).toBe(0);
    expect(
      (await git(["rev-parse", "--verify", "refs/heads/bobs"], dir)).code,
    ).toBe(0);
    expect(await allRefs(sourceDir)).toBe(sourceRefs);
  }, 60_000);

  test("refusals are words, and nothing is made", async () => {
    const count = () =>
      (app.db.query("SELECT COUNT(*) AS n FROM repo").get() as { n: number }).n;
    const before = count();
    for (const url of [
      "file:///etc",
      "ext::sh -c touch% /tmp/pwned",
      "ssh://git@example.com/a/b.git",
      "git@example.com:a/b.git",
      "--upload-pack=touch /tmp/pwned",
      "https://user:secret@example.com/a/b.git",
      "",
    ]) {
      const response = await api("bob", "/api/v1/migrate", { source: { url } });
      expect(response.status).toBe(422);
      const body = (await response.json()) as {
        error: string;
        message: string;
      };
      expect(body.error).toBe("invalid_url");
      expect(body.message).toContain("not a URL this forge will clone from");
    }
    // What a person meant is what they get.
    expect(migrateUrl("github.com/a/b")).toBe("https://github.com/a/b");
    expect(migrateUrl("git://example.com/a/b.git")).toBe(
      "git://example.com/a/b.git",
    );

    // bob already has a `fixture`.
    const taken = await api("bob", "/api/v1/migrate", {
      source: { url: fixtureUrl },
    });
    expect(taken.status).toBe(422);
    expect(((await taken.json()) as { error: string }).error).toBe(
      "name_taken",
    );
    const invalid = await api("bob", "/api/v1/migrate", {
      source: { url: fixtureUrl },
      name: "no spaces allowed",
    });
    expect(((await invalid.json()) as { error: string }).error).toBe(
      "invalid_name",
    );
    const agent = await api("bob", "/api/v1/migrate", {
      source: { url: fixtureUrl },
      name: "other",
      crew: { agent: "nobody-here", autonomous: false },
    });
    expect(((await agent.json()) as { error: string }).error).toBe(
      "no_such_agent",
    );

    // The same refusal on the web: the form again, with the reason in it.
    const page = await browser(bobCookie, "/migrate", {
      url: fixtureUrl,
      owner: "bob",
      name: "",
    });
    expect(page.status).toBe(422);
    expect(await page.text()).toContain(
      "already has a repository by that name",
    );
    const both = await browser(bobCookie, "/migrate", {
      source: "x/octo/y",
      url: fixtureUrl,
    });
    expect(await both.text()).toContain("not both");
    expect(count()).toBe(before);
  });

  test("a clone that fails leaves nothing behind", async () => {
    // A private repository is not there for an anonymous clone.
    const made = await createRepo(app, alice, {
      name: "hidden",
      visibility: "private",
    });
    expect(made.ok).toBe(true);
    const started = await migrateRepo(app, bob, {
      source: { url: `${base}/alice/hidden.git` },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const job = await settled(started.value.job.id);
    expect(job?.stage).toBe("failed");
    expect(job?.error).toContain("could not be read");
    expect(getRepo(app.db, "bob", "hidden")).toBeUndefined();
    expect(existsSync(repoDir(app.reposRoot, "bob", "hidden"))).toBe(false);
  });

  test("with a crew: on the crew, an app, the importer's brief, autonomy when asked", async () => {
    const agent = await createAgent(app, alice, {
      username: "porter",
      model: "",
      brief: "Moves things in.",
    });
    expect(agent.ok).toBe(true);

    for (const [name, autonomous] of [
      ["crewed", true],
      ["assisted", false],
    ] as const) {
      const started = await migrateRepo(app, bob, {
        source: { url: fixtureUrl },
        name,
        crew: { agent: "porter", autonomous },
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const job = await settled(started.value.job.id);
      expect(job?.error).toBeUndefined();
      expect(job?.stage).toBe("done");
      expect(job?.detail).toContain("porter is on it");

      const repo = getRepo(app.db, "bob", name)!;
      const crew = listCrew(app, bob, repo);
      expect(crew.ok && crew.value.map((a) => a.user.username)).toEqual([
        "porter",
      ]);
      expect(getAppByRepo(app.db, repo.id)).toBeDefined();
      expect(repo.autonomy).toBe(autonomous ? "autonomous" : "off");

      const issues = listIssues(app.db, repo.id, {
        kind: "issue",
        state: "open",
      });
      expect(issues.length).toBe(1);
      const issue = issues[0]!;
      expect(issue.title).toBe(`Make ${name} run here`);
      expect(issue.assigneeName).toBe("porter");
      for (const words of [
        "Adapt, don't rewrite",
        "forge.json",
        "`run`",
        "`health`",
        "PORT",
        "FORGE_APP_DATA",
        "no Dockerfile, no compose",
        "could not fit",
        fixtureUrl,
      ])
        expect(issue.body).toContain(words);
    }
  }, 60_000);

  test("from an origin: the origin's credential opens a private repository", async () => {
    const connected = await browser(aliceCookie, "/settings/origins/token", {
      host: forgejo.url,
      token: UPSTREAM_SECRET,
    });
    expect(connected.status).toBe(303);
    const origin = listOrigins(app.db, alice.id)[0]!;

    // Anonymous, by URL: refused by the upstream, and nothing left here.
    const anon = await migrateRepo(app, alice, {
      source: { url: `${upstreamServers.url}/octo/secret-widgets.git` },
    });
    expect(anon.ok).toBe(true);
    if (!anon.ok) return;
    expect((await settled(anon.value.job.id))?.stage).toBe("failed");

    // Picked from the origin: the header opens it.
    const response = await api("alice", "/api/v1/migrate", {
      source: { originId: origin.id, fullName: "octo/secret-widgets" },
    });
    // A password is the account itself; it clears the admin floor.
    expect(response.status).toBe(202);
    const started = (await response.json()) as { job: { id: string } };
    const job = await settled(started.job.id);
    expect(job?.error).toBeUndefined();
    expect(job?.stage).toBe("done");
    const migrated = getRepo(app.db, "alice", "secret-widgets")!;
    expect(migrated.origin).toBeNull();
    expect(migrated.description).toBe("gears, privately");
    const dir = repoDir(app.reposRoot, "alice", "secret-widgets");
    expect((await git(["log", "--format=%s", "main"], dir)).out).toBe("first");
    // The credential rode in the environment and stayed there.
    const config = await Bun.file(join(dir, "config")).text();
    expect(config).not.toContain(UPSTREAM_SECRET);
    expect(config).not.toContain("extraHeader");

    // Someone else's origin is not a source.
    const bobs = await api("bob", "/api/v1/migrate", {
      source: { originId: origin.id, fullName: "octo/secret-widgets" },
    });
    expect(((await bobs.json()) as { error: string }).error).toBe(
      "no_such_origin",
    );
  }, 60_000);

  test("the page: the form, the plus menu, the job, and who may see it", async () => {
    const anonymous = await browser("", "/migrate");
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toStartWith("/signin");

    const html = await (await browser(aliceCookie, "/migrate")).text();
    expect(html).toContain('action="/migrate"');
    expect(html).toContain('name="url"');
    expect(html).toContain('name="source"');
    expect(html).toContain("octo/secret-widgets");
    expect(html).toContain("Put a crew on it");
    expect(html).toContain('name="agent"');
    expect(html).toContain('name="autonomous"');
    // The "+" menu carries it on every page, beside New repository.
    const home = await (await browser(aliceCookie, "/")).text();
    expect(home).toContain('href="/migrate"');
    expect(home.indexOf('href="/new"')).toBeLessThan(
      home.indexOf('href="/migrate"'),
    );

    // A cross-site post is refused before anything happens.
    const forged = await browser(
      aliceCookie,
      "/migrate",
      { url: fixtureUrl, name: "forged" },
      "https://evil.test",
    );
    expect(forged.status).toBe(403);
    expect(getRepo(app.db, "alice", "forged")).toBeUndefined();

    const posted = await browser(aliceCookie, "/migrate", {
      source: "",
      url: fixtureUrl,
      owner: "alice",
      name: "copy",
      agent: "porter",
      autonomous: "on",
    });
    expect(posted.status).toBe(303);
    const where = posted.headers.get("location")!;
    expect(where).toStartWith("/migrate/jobs/");
    await settled(where.split("/").pop()!);
    // Nobody else watches alice's migration.
    expect((await browser(bobCookie, where)).status).toBe(404);
    const landed = await browser(aliceCookie, where);
    expect(landed.status).toBe(303);
    expect(landed.headers.get("location")).toBe("/alice/copy");
    const repoPage = await (
      await browser(
        `${aliceCookie}; ${(landed.headers.get("set-cookie") ?? "").split(";")[0]}`,
        "/alice/copy",
      )
    ).text();
    expect(repoPage).toContain("Migrated as alice/copy");
    expect(getRepo(app.db, "alice", "copy")?.autonomy).toBe("autonomous");
  }, 60_000);

  test("a pasted address inside the network is an admin's alone, unless the forge says otherwise", async () => {
    const { isPrivateHost } = await import("../src/actions/migrate.ts");
    for (const h of [
      "127.0.0.1",
      "localhost",
      "app.localhost",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.9",
      "169.254.1.1",
      "::1",
      "fd00::1",
      "0.0.0.0",
      "[::ffff:127.0.0.1]",
      "::ffff:7f00:1",
      "0:0:0:0:0:ffff:7f00:1",
      "::FFFF:10.0.0.1",
      "[::ffff:c0a8:1]",
      "fe80::1",
      "[::]",
    ])
      expect(isPrivateHost(h)).toBe(true);
    for (const h of [
      "github.com",
      "8.8.8.8",
      "172.32.0.1",
      "git.open-platform.sh",
      "2606:4700::1",
      "::ffff:8.8.8.8",
      "[2001:db8::1]",
    ])
      expect(isPrivateHost(h)).toBe(false);
    const strictDir = await mkdtemp(join(tmpdir(), "forge-migrate-strict-"));
    const strict = createApp({ dataDir: strictDir, port: 0 });
    try {
      const a = await createUser(strict.db, {
        username: "ann",
        email: "ann@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      const b = await createUser(strict.db, {
        username: "ben",
        email: "ben@forge.local",
        password: "a-good-passphrase",
      });
      if (!a.ok || !b.ok) throw new Error("users");
      const refused = await migrateRepo(strict, b.value, {
        source: { url: `${base}/alice/hidden.git` },
      });
      expect(refused).toEqual({ ok: false, error: "private_host" });
      const allowed = await migrateRepo(strict, a.value, {
        source: { url: `${base}/alice/hidden.git` },
        name: "peek",
      });
      expect(allowed.ok).toBe(true);
    } finally {
      strict.close();
      await rm(strictDir, { recursive: true, force: true });
    }
  });

  test("a clone follows no redirect: the address that was checked is the only one fetched", async () => {
    let hits = 0;
    const target = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        hits++;
        return new Response("here", { status: 200 });
      },
    });
    const hop = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        return new Response(null, {
          status: 302,
          headers: {
            location: `http://127.0.0.1:${target.port}/x.git/info/refs?service=git-upload-pack`,
          },
        });
      },
    });
    try {
      const started = await migrateRepo(app, alice, {
        source: { url: `http://127.0.0.1:${hop.port}/hop.git` },
        name: "hopped",
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const job = await settled(started.value.job.id);
      expect(job?.stage).toBe("failed");
      expect(hits).toBe(0);
    } finally {
      hop.stop(true);
      target.stop(true);
    }
  });
});
