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
import {
  isPrivateHost,
  migrateRepo,
  migrateUrl,
} from "../src/actions/migrate.ts";
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
import { createUser, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createToken } from "../src/core/tokens.ts";
import { createSession } from "../src/core/sessions.ts";
import { settled } from "../src/origins/jobs.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { prefill } from "../src/web/pages/migrate-prefill.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

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
  let work: string;
  let app: App;
  let servers: Servers;
  let forgejo: FakeForge;
  let base: string;
  let alice: User;
  let bob: User;
  let aliceCookie = "";
  let bobCookie = "";
  let bobToken = "";
  let fixtureUrl = "";
  let originId = "";
  // octo's credential at the "upstream": a token, since a password would
  // cost an argon2 verify on every git request.
  let upstreamSecret = "";

  const person = async (
    username: string,
    adminIfFirst = false,
  ): Promise<User> => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.test`,
      adminIfFirst,
    });
    if (!made.ok) throw new Error(String(made.error));
    promote(app.db, made.value);
    return made.value;
  };

  const cookieOf = (user: User): string =>
    `forge_session=${createSession(app.db, user.id).token}`;

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

  /** The same call with a bearer token: no cookie, no origin header. */
  const apiToken = (token: string, payload: unknown): Promise<Response> =>
    fetch(`${base}/api/v1/migrate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

  const api = (cookie: string, payload: unknown): Promise<Response> =>
    fetch(`${base}/api/v1/migrate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: new URL(base).origin,
      },
      body: JSON.stringify(payload),
    });

  /** Start a migration and wait for it; the job is returned as it ended. */
  const migrate = async (
    user: User,
    input: Parameters<typeof migrateRepo>[2],
  ) => {
    const started = await migrateRepo(app, user, input);
    if (!started.ok) throw new Error(started.error);
    return settled(started.value.job.id);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-migrate-"));
    work = await mkdtemp(join(tmpdir(), "forge-migrate-work-"));
    // The fixture's source is the forge itself, on loopback: a private host,
    // which a personal forge may say is fine. Its hook socket is what a
    // real push needs; no argon2 per request (sessions and tokens, not
    // passwords).
    app = createApp({ dataDir, port: 0, migrateFromPrivateHosts: true });
    servers = await serve(app);
    base = `http://127.0.0.1:${servers.port}`;
    // No passwords: argon2 is the slow part of an account, and every
    // request here rides a session or a token.
    alice = await person("alice", true);
    bob = await person("bob");
    const octo = await person("octo");
    upstreamSecret = createToken(app.db, octo.id, "upstream", "rw").token;
    aliceCookie = cookieOf(alice);
    bobCookie = cookieOf(bob);
    bobToken = createToken(app.db, bob.id, "cli", "rw").token;

    // The fixture: alice's public repository with three branches, two tags
    // (one annotated), and `trunk` as its default — not the forge's `main`.
    const made = await createRepo(app, alice, {
      name: "fixture",
      visibility: "public",
    });
    if (!made.ok) throw new Error(made.error);
    const fixture = made.value;
    const commit = async (
      user: User,
      repo: Repo,
      branch: string,
      path: string,
      message: string,
    ) => {
      const done = await commitToBranch(app, user, repo, {
        branch,
        message,
        files: [{ path, content: `${message}\n` }],
      });
      if (!done.ok) throw new Error(String(done.error));
    };
    await commit(alice, fixture, "main", "README.md", "first");
    await commit(alice, fixture, "main", "a.txt", "second");
    await commit(alice, fixture, "trunk", "trunk.txt", "on trunk");
    await commit(alice, fixture, "feature", "feature.txt", "a feature");
    await commit(alice, fixture, "feature", "feature2.txt", "more feature");
    const settings = await updateRepoSettings(app, alice, fixture, {
      defaultBranch: "trunk",
    });
    if (!settings.ok) throw new Error(settings.error);
    const dir = repoDir(app.reposRoot, "alice", "fixture");
    expect((await git(["tag", "v1", "main~1"], dir)).code).toBe(0);
    expect(
      (await git(["tag", "-a", "v2", "-m", "the second", "feature"], dir)).code,
    ).toBe(0);
    fixtureUrl = `${base}/alice/fixture.git`;

    // A repository alice keeps private: no anonymous clone reaches it.
    const hidden = await createRepo(app, alice, {
      name: "hidden",
      visibility: "private",
    });
    if (!hidden.ok) throw new Error(hidden.error);
    await commit(alice, hidden.value, "main", "README.md", "secret");

    // A private repository behind a fake origin whose clone URL points at
    // it: only the origin's credential (octo's) opens it.
    const widgets = await createRepo(app, octo, {
      name: "secret-widgets",
      visibility: "private",
    });
    if (!widgets.ok) throw new Error(widgets.error);
    await commit(octo, widgets.value, "main", "README.md", "first");
    const state = newFakeState("forgejo", "octo", upstreamSecret);
    state.repos.push({
      id: 77,
      fullName: "octo/secret-widgets",
      description: "gears, privately",
      cloneUrl: `${base}/octo/secret-widgets.git`,
      htmlUrl: `${base}/octo/secret-widgets`,
      defaultBranch: "main",
      private: true,
    });
    forgejo = serveFakeForge(state);
    forgetProviders(dataDir);
    const connected = await browser(aliceCookie, "/settings/origins/token", {
      host: forgejo.url,
      token: upstreamSecret,
    });
    expect(connected.status).toBe(303);
    originId = listOrigins(app.db, alice.id)[0]!.id;
  }, 30_000);

  afterAll(async () => {
    forgejo.stop();
    servers.stop();
    app.close();
    forgetProviders(dataDir);
    for (const dir of [dataDir, work])
      await rm(dir, { recursive: true, force: true });
  });

  test("by URL: the whole history arrives in a native repository, and pushes stay here", async () => {
    const sourceDir = repoDir(app.reposRoot, "alice", "fixture");
    const sourceRefs = await allRefs(sourceDir);

    // By token, so the non-cookie door to the endpoint stays covered.
    const response = await apiToken(bobToken, { source: { url: fixtureUrl } });
    expect(response.status).toBe(202);
    const started = (await response.json()) as {
      repo: { name: string };
      job: { id: string };
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
    // Native: no origin row, no remote in its config — nothing a push could
    // write through to, so pushes land here and the source never hears.
    expect(migrated.origin).toBeNull();
    expect((await git(["config", "--get-regexp", "^remote\\."], dir)).out).toBe(
      "",
    );

    // A real push lands here, and the source never hears of it.
    const clone = join(work, "bob-fixture");
    const url = new URL(`${base}/bob/fixture.git`);
    url.username = "bob";
    url.password = bobToken;
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
  });

  test("a URL git must not run is refused in words before anything exists", async () => {
    const count = () =>
      (app.db.query("SELECT COUNT(*) AS n FROM repo").get() as { n: number }).n;
    const before = count();
    // What a hostile URL would touch if git ever ran it: a path of this
    // test's own.
    const canary = join(work, "touched-by-git");
    for (const url of [
      "file:///etc",
      `ext::sh -c touch% ${canary}`,
      "ssh://git@example.com/a/b.git",
      "git@example.com:a/b.git",
      `--upload-pack=touch ${canary}`,
      "https://user:secret@example.com/a/b.git",
      "",
    ])
      expect(await migrateRepo(app, bob, { source: { url } })).toEqual({
        ok: false,
        error: "invalid_url",
      });
    expect(existsSync(canary)).toBe(false);
    // On the wire it is a 422 with words.
    const response = await api(bobCookie, { source: { url: "file:///etc" } });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_url");
    expect(body.message).toContain("not a URL this forge will clone from");
    // What a person meant is what they get.
    expect(migrateUrl("github.com/a/b")).toBe("https://github.com/a/b");
    expect(migrateUrl("git://example.com/a/b.git")).toBe(
      "git://example.com/a/b.git",
    );
    expect(count()).toBe(before);
  });

  test("a name, an agent or a form that cannot work is refused before anything exists", async () => {
    const made = await createRepo(app, bob, { name: "taken" });
    expect(made.ok).toBe(true);
    const count = () =>
      (app.db.query("SELECT COUNT(*) AS n FROM repo").get() as { n: number }).n;
    const before = count();
    const refused = (input: Parameters<typeof migrateRepo>[2]) =>
      migrateRepo(app, bob, input).then((r) => (r.ok ? "ok" : r.error));
    expect(await refused({ source: { url: fixtureUrl }, name: "taken" })).toBe(
      "name_taken",
    );
    expect(
      await refused({
        source: { url: fixtureUrl },
        name: "no spaces allowed",
      }),
    ).toBe("invalid_name");
    expect(
      await refused({
        source: { url: fixtureUrl },
        name: "other",
        crew: { agent: "nobody-here", autonomous: false },
      }),
    ).toBe("no_such_agent");

    // The same refusal on the web: the form again, with the reason in it.
    const page = await browser(bobCookie, "/migrate", {
      url: fixtureUrl,
      owner: "bob",
      name: "taken",
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
    const job = await migrate(bob, {
      source: { url: `${base}/alice/hidden.git` },
    });
    expect(job?.stage).toBe("failed");
    expect(job?.error).toContain("could not be read");
    expect(getRepo(app.db, "bob", "hidden")).toBeUndefined();
    expect(existsSync(repoDir(app.reposRoot, "bob", "hidden"))).toBe(false);
  });

  test("with a crew: on the crew, an app, the importer's brief, autonomy only when asked", async () => {
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
      const job = await migrate(bob, {
        source: { url: fixtureUrl },
        name,
        crew: { agent: "porter", autonomous },
      });
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
      // The importer's brief is the same whether or not the crew is
      // autonomous; autonomy is the repository's setting, asserted above.
      for (const words of [
        "Adapt, don't rewrite",
        "forge.json",
        "`run`",
        "`health`",
        "PORT",
        "FORGE_APP_DATA",
        "no Dockerfile, no compose",
        "could not fit",
        "Its data:",
        "Leave the old database untouched",
        "one-shot import script",
        "dump file in",
        "how to make the dump",
        "Never commit or read at boot a connection string",
        fixtureUrl,
      ])
        expect(issue.body).toContain(words);
    }
  });

  test("from an origin: the origin's credential opens a private repository", async () => {
    // Anonymous, by URL: refused by the upstream, and nothing left here.
    const anon = await migrate(alice, {
      source: { url: `${base}/octo/secret-widgets.git` },
    });
    expect(anon?.stage).toBe("failed");

    // Picked from the origin: the header opens it.
    const response = await api(aliceCookie, {
      source: { originId, fullName: "octo/secret-widgets" },
    });
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
    expect(config).not.toContain(upstreamSecret);
    expect(config).not.toContain("extraHeader");

    // Someone else's origin is not a source.
    const bobs = await api(bobCookie, {
      source: { originId, fullName: "octo/secret-widgets" },
    });
    expect(((await bobs.json()) as { error: string }).error).toBe(
      "no_such_origin",
    );
  });

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
  });

  test("a link prefills the form and starts nothing", async () => {
    const host = new URL(forgejo.url).host;
    expect(host).toContain(":"); // the fake forge has a port; the label would not
    const already = getRepo(app.db, "alice", "secret-widgets")?.id;
    const get = async (qs: string) =>
      (await browser(aliceCookie, `/migrate?${qs}`)).text();

    const hit = await get(
      new URLSearchParams({ from: `${host}/octo/secret-widgets`, crew: "porter" }).toString(),
    );
    expect(hit).toMatch(/<option\s+value="[^"]+\/octo\/secret-widgets"[^>]*selected/);
    expect(hit).toMatch(/<option[^>]*value="porter"[^>]*selected|selected[^>]*value="porter"/);
    expect(hit).not.toContain("prefill-unmatched");

    const miss = await get(
      new URLSearchParams({
        from: `other.example/octo/secret-widgets`,
        crew: `<script>alert(1)</script>`,
      }).toString(),
    );
    expect(miss).toContain("prefill-unmatched");
    expect(miss).toContain("from=other.example/octo/secret-widgets");
    expect(miss).not.toContain("<script>alert(1)");
    expect(miss).toContain("&lt;script&gt;");
    expect(miss).not.toMatch(/<option[^>]*value="[^"]+"[^>]*selected[^>]*>\s*octo/);

    // A link starts nothing: no repository, no job.
    expect(getRepo(app.db, "alice", "secret-widgets")?.id).toBe(already);
  });

  test("a pasted address inside the network is an admin's alone, unless the forge says otherwise", async () => {
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
    // The forge without the personal-forge switch: bob is refused, alice
    // (the admin) is not. The flag is flipped in place: this only proves
    // anything because migrateRepo reads it on every call, which the
    // refusal below (the app was built with it true) fails without.
    const config = app.config as { migrateFromPrivateHosts?: boolean };
    config.migrateFromPrivateHosts = false;
    try {
      const refused = await migrateRepo(app, bob, {
        source: { url: `${base}/alice/hidden.git` },
      });
      expect(refused).toEqual({ ok: false, error: "private_host" });
      const allowed = await migrateRepo(app, alice, {
        source: { url: `${base}/alice/hidden.git` },
        name: "peek",
      });
      expect(allowed.ok).toBe(true);
      if (allowed.ok) await settled(allowed.value.job.id);
    } finally {
      config.migrateFromPrivateHosts = true;
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
      const job = await migrate(alice, {
        source: { url: `http://127.0.0.1:${hop.port}/hop.git` },
        name: "hopped",
      });
      expect(job?.stage).toBe("failed");
      expect(hits).toBe(0);
    } finally {
      hop.stop(true);
      target.stop(true);
    }
  });
});

describe("migrate prefill", () => {
  const origins = [
    { id: "o1", host: "git.example.test:3000", repos: [{ fullName: "Octo/Widgets" }] },
    { id: "o2", host: "git.open-platform.sh", repos: [{ fullName: "trevato/forge" }] },
  ];
  const agents = ["porter", "scout"];

  test("a host with a port, and one without", () => {
    expect(prefill({ from: "git.example.test:3000/octo/widgets" }, origins, agents).repo).toEqual({
      originId: "o1",
      fullName: "Octo/Widgets",
    });
    const plain = prefill({ from: "GIT.open-platform.sh/trevato/forge", crew: "scout" }, origins, agents);
    expect(plain.repo?.originId).toBe("o2");
    expect(plain.agent).toBe("scout");
    expect(plain.unmatched).toEqual([]);
  });

  test("a mismatch is named, never guessed (not the display label)", () => {
    const r = prefill({ from: "git/trevato/forge", crew: "nobody" }, origins, agents);
    expect(r.repo).toBeUndefined();
    expect(r.agent).toBeUndefined();
    expect(r.unmatched).toEqual(["from=git/trevato/forge", "crew=nobody"]);
    expect(prefill({ from: "git.example.test/octo/widgets" }, origins, agents).repo).toBeUndefined();
  });

  test("a hostile or oversized value is ignored and capped", () => {
    const r = prefill({ from: "<img src=x onerror=1>/a/b", crew: "x".repeat(500) }, origins, agents);
    expect(r.repo).toBeUndefined();
    expect(r.unmatched).toHaveLength(2);
    expect(r.unmatched.every((u) => u.length < 100)).toBe(true);
  });
});
