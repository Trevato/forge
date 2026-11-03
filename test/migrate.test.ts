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
  fetchEnv,
  migrateMessage,
  resolveSource,
  migrateUrl,
} from "../src/actions/migrate.ts";
import { createAgent, listCrew } from "../src/actions/crew.ts";
import { connectOrigin } from "../src/actions/origins.ts";
import { getPull, pullStatus } from "../src/core/pulls.ts";
import { pullMayRun } from "../src/core/pull_trust.ts";
import { approveHere } from "../src/actions/pulls.ts";
import { labelsFor, listComments } from "../src/core/issues.ts";
import { backlink } from "../src/origins/carry.ts";
import { formatKib, matchesFilter } from "../src/web/pages/migrate.ts";
import {
  commitToBranch,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { listIssues } from "../src/core/issues.ts";
import { listOrigins } from "../src/core/origins.ts";
import {
  getProvenance,
  recordProvenance,
  setProvenanceShown,
} from "../src/core/provenance.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createToken } from "../src/core/tokens.ts";
import { createSession } from "../src/core/sessions.ts";
import { advance, createJob, settled } from "../src/origins/jobs.ts";
import { getFollow } from "../src/core/upstream_follow.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import {
  newFakeOAuth,
  newFakeState,
  serveFakeForge,
  type FakeForge,
} from "./fake-origin.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { STAGE_BADGE_JS } from "../src/web/stage-row.ts";
import { prefill } from "../src/web/pages/migrate-prefill.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";
import { withScripts } from "./helpers/page-script.ts";

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
  let octo: User;
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
    octo = await person("octo");
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
    // A public fork on the origin, whose host says what it forks (#3293).
    state.repos.push({
      id: 78,
      fullName: "octo/arm",
      description: "an arm, forked",
      cloneUrl: `${base}/octo/secret-widgets.git`,
      htmlUrl: "https://code.example/octo/arm",
      defaultBranch: "main",
      fork: true,
      parent: "TheRobotStudio/arm",
    });
    // A private fork: its name is not ours to publish, whatever it becomes.
    state.repos.push({
      id: 79,
      fullName: "octo/hush",
      description: "a quiet fork",
      cloneUrl: `${base}/octo/secret-widgets.git`,
      htmlUrl: "https://code.example/octo/hush",
      defaultBranch: "main",
      private: true,
      fork: true,
      parent: "TheRobotStudio/hush",
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
    // Where it came from is kept as a link, the `.git` dropped; a plain
    // http host on loopback is not asked what it forks (#3293).
    expect(getProvenance(app.db, migrated.id)).toMatchObject({
      sourceUrl: `${base}/alice/fixture`,
      parents: [],
      shown: true,
    });
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
    expect(migrateUrl("git://example.com/a/b.git")).toBeUndefined();
    expect(migrateUrl("https://example.com/a/b.git")).toBe(
      "https://example.com/a/b.git",
    );
    expect(migrateMessage("invalid_url")).toContain("git:// address is not supported");
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
      // The source is the upstream it follows: on when autonomous (#3442).
      const follow = getFollow(app.db, repo.id)!;
      expect([follow.url, follow.branch, follow.enabled]).toEqual([fixtureUrl, "trunk", autonomous]);

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

  test("a migrated fork shows its trail, and its owner can hide it and bring it back", async () => {
    const job = await migrate(alice, {
      source: { originId, fullName: "octo/arm" },
      visibility: "public",
    });
    expect(job?.error).toBeUndefined();
    const repo = getRepo(app.db, "alice", "arm")!;
    const lineage = async (cookie: string): Promise<string> => {
      const page = await (await browser(cookie, "/alice/arm")).text();
      return /<p class="muted small break" data-lineage>[\s\S]*?<\/p>/.exec(page)?.[0] ?? "";
    };
    const shown = await lineage("");
    expect(shown).toContain("Migrated from");
    expect(shown).toContain(
      '<a href="https://code.example/octo/arm" rel="noopener noreferrer">code.example/octo/arm</a>',
    );
    expect(shown).toContain("fork of");
    expect(shown).toContain(
      '<a href="https://code.example/TheRobotStudio/arm" rel="noopener noreferrer">TheRobotStudio/arm</a>',
    );
    const facts = async () =>
      ((await (await browser("", "/api/v1/repos/alice/arm")).json()) as {
        provenance: { source: string; parents: { url: string }[] } | null;
      }).provenance;
    expect((await facts())?.source).toBe("code.example/octo/arm");
    expect((await facts())?.parents[0]?.url).toBe(
      "https://code.example/TheRobotStudio/arm",
    );

    // Not bob's to hide: he can read it, not administer it.
    const refused = await browser(bobCookie, "/alice/arm/settings/provenance", {
      shown: "0",
    });
    expect(refused.status).not.toBe(303);
    expect(getProvenance(app.db, repo.id)?.shown).toBe(true);

    // Off: gone for anyone else and from the API, the record kept.
    const settings = await (await browser(aliceCookie, "/alice/arm/settings")).text();
    expect(settings).toContain("Hide where this came from");
    const off = await browser(aliceCookie, "/alice/arm/settings/provenance", {
      shown: "0",
    });
    expect(off.status).toBe(303);
    expect(await lineage("")).toBe("");
    expect(await lineage(bobCookie)).toBe("");
    expect(await facts()).toBeNull();
    expect(getProvenance(app.db, repo.id)).toMatchObject({
      sourceUrl: "https://code.example/octo/arm",
      parents: ["TheRobotStudio/arm"],
      shown: false,
    });

    // On again, by the API this time: back as it was.
    const on = await fetch(`${base}/api/v1/repos/alice/arm`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: aliceCookie,
        origin: new URL(base).origin,
      },
      body: JSON.stringify({ showProvenance: true }),
    });
    expect(on.status).toBe(200);
    expect(await lineage("")).toBe(shown);
  });

  test("a private source migrated as public keeps its trail hidden until its owner shows it", async () => {
    const job = await migrate(alice, {
      source: { originId, fullName: "octo/hush" },
      visibility: "public",
    });
    expect(job?.error).toBeUndefined();
    const repo = getRepo(app.db, "alice", "hush")!;
    expect(repo.visibility).toBe("public");
    const page = await (await browser("", "/alice/hush")).text();
    expect(page).not.toContain("data-lineage");
    expect(page).not.toContain("octo/hush");
    const api = (await (await browser("", "/api/v1/repos/alice/hush")).json()) as {
      provenance: unknown;
    };
    expect(api.provenance).toBeNull();
    expect(getProvenance(app.db, repo.id)).toMatchObject({
      sourceUrl: "https://code.example/octo/hush",
      parents: ["TheRobotStudio/hush"],
      shown: false,
    });
    const settings = await (await browser(aliceCookie, "/alice/hush/settings")).text();
    expect(settings).toContain("Hidden: nobody else sees it");
    expect(settings).not.toContain("Hide where this came from");
    expect(settings).toMatch(/<button[^>]*>\s*Show where this came from/);

    // A second record (a re-migration's) leaves the owner's choice alone.
    setProvenanceShown(app.db, repo.id, true);
    recordProvenance(app.db, repo.id, {
      url: "https://code.example/octo/hush",
      parents: [],
      shown: false,
    });
    expect(getProvenance(app.db, repo.id)?.shown).toBe(true);
  });

  test("one click from GitHub: the repository, 3 issues, 1 open pull request and a crew run on the app", async () => {
    // Upstream: a private repository with a branch an open pull stands on.
    const made = await createRepo(app, octo, {
      name: "gadgets",
      visibility: "private",
    });
    if (!made.ok) throw new Error(made.error);
    for (const [branch, path] of [
      ["main", "README.md"],
      ["fix-typo", "typo.txt"],
    ] as const) {
      const done = await commitToBranch(app, octo, made.value, {
        branch,
        message: `on ${branch}`,
        files: [{ path, content: "x\n" }],
      });
      if (!done.ok) throw new Error(String(done.error));
    }
    const upstreamDir = repoDir(app.reposRoot, "octo", "gadgets");
    const headSha = (await git(["rev-parse", "fix-typo"], upstreamDir)).out;

    // A fake GitHub API in front of it, seeded: 3 issues (one closed, one
    // with a comment), 1 open pull request, and 1 closed one that stays.
    const state = newFakeState("github", "octo", upstreamSecret);
    state.repos.push({
      id: 501,
      fullName: "octo/gadgets",
      description: "small machines",
      cloneUrl: `${base}/octo/gadgets.git`,
      htmlUrl: "https://github.com/octo/gadgets",
      defaultBranch: "main",
      private: true,
      sizeKb: 2048,
    });
    state.labels.set("octo/gadgets", [{ id: 9, name: "bug", color: "d73a4a" }]);
    state.issues.set("octo/gadgets", [
      { id: 601, number: 1, title: "Crashes on start", body: "Stack trace.", user: "mona", labels: ["bug"], commentCount: 1 },
      { id: 602, number: 2, title: "An old thing", user: "hubot", state: "closed", closedAt: "2026-01-02T00:00:00Z" },
      { id: 603, number: 3, title: "Write the docs", user: "mona" },
      {
        id: 604,
        number: 4,
        title: "Fix the typo",
        body: "One letter.",
        user: "octocat",
        pull: { base: "main", head: "fix-typo", headRepo: "octo/gadgets", headSha },
      },
      {
        id: 605,
        number: 5,
        title: "Turned down",
        user: "octocat",
        state: "closed",
        pull: { base: "main", head: "nope", headRepo: "octo/gadgets" },
      },
    ]);
    state.comments.set("octo/gadgets", [
      { id: 701, issueNumber: 1, body: "Same here.", user: "hubot" },
    ]);
    const github = serveFakeForge(state);
    try {
      forgetProviders(dataDir);
      const connected = await connectOrigin(app, alice, {
        host: github.url,
        kind: "github",
        token: upstreamSecret,
      });
      if (!connected.ok) throw new Error(JSON.stringify(connected.error));
      const agent = await createAgent(app, alice, {
        username: "mover",
        model: "",
        brief: "Moves things in.",
      });
      expect(agent.ok).toBe(true);

      // The picker: a row, marked private, sized, with its one button —
      // and the account it came through can be disconnected from here.
      const html = await (await browser(aliceCookie, "/migrate")).text();
      const row = new RegExp(`name="pick"\\s+value="(${connected.value.id}/octo/gadgets)"`).exec(html);
      expect(row).not.toBeNull();
      expect(html).toContain("2.0 MiB");
      expect(html).toContain("Migrate with the crew");
      expect(html).toContain(`action="/settings/origins/${connected.value.id}/delete"`);
      expect(html).toContain('name="then" value="migrate"');

      // The filter narrows the rows on the server too (no script needed).
      const filtered = await (await browser(aliceCookie, "/migrate?q=nothing-like-it")).text();
      expect(filtered).not.toContain('value="' + row![1] + '"');

      // One click: the row's button and the form's fields as they stood.
      const posted = await browser(aliceCookie, "/migrate", {
        pick: row![1]!,
        url: "",
        owner: "alice",
        name: "",
        visibility: "private",
        agent: "mover",
      });
      expect(posted.status).toBe(303);
      const where = posted.headers.get("location")!;
      const job = await settled(where.split("/").pop()!);
      expect(job?.error).toBeUndefined();
      expect(job?.stage).toBe("done");
      expect(job?.detail).toContain("3 issues, 1 open pull request, 1 comment");
      // It ends at the app: the repository's page is the app's.
      const landed = await browser(aliceCookie, where);
      expect(landed.headers.get("location")).toBe("/alice/gadgets");

      const repo = getRepo(app.db, "alice", "gadgets")!;
      expect(repo.origin).toBeNull();
      expect(getAppByRepo(app.db, repo.id)).toBeDefined();

      // The issues, open and closed, numbered as they were, by their
      // GitHub authors, each linking back.
      const carried = listIssues(app.db, repo.id, { kind: "issue", state: "all" })
        .filter((i) => i.originAuthor !== null)
        .sort((a, b) => a.number - b.number);
      expect(carried.map((i) => [i.number, i.state, i.originAuthor])).toEqual([
        [1, "open", "mona"],
        [2, "closed", "hubot"],
        [3, "open", "mona"],
      ]);
      expect(carried[0]!.body).toStartWith(
        "> Migrated from [octo/gadgets#1](",
      );
      expect(carried[0]!.body).toContain("by @mona on GitHub.");
      expect(carried[0]!.body).toContain("Stack trace.");
      expect(labelsFor(app.db, carried[0]!.id).map((l) => l.name)).toEqual(["bug"]);
      const comments = listComments(app.db, carried[0]!.id);
      expect(comments.map((c) => [c.originAuthor, c.body])).toEqual([
        ["hubot", "Same here."],
      ]);

      // One pull request — the open one — native here, on its branch.
      const pulls = listIssues(app.db, repo.id, { kind: "pull", state: "all" });
      expect(pulls.map((p) => p.number)).toEqual([4]);
      const pull = getPull(app.db, repo.id, 4)!;
      expect(pull.headBranch).toBe("fix-typo");
      expect(pull.originHeadRepo).toBeNull();
      expect(pull.body).toContain("by @octocat on GitHub.");
      const dir = repoDir(app.reposRoot, "alice", "gadgets");
      expect((await git(["rev-parse", "fix-typo"], dir)).out).toBe(headSha);

      // The crew's brief is the next number, assigned to the agent: the
      // durable event the dispatcher (`crew/dispatch.ts`, started by
      // main.ts) queues the first run from.
      const brief = listIssues(app.db, repo.id, { kind: "issue", state: "open" })
        .find((i) => i.originAuthor === null)!;
      expect(brief.number).toBe(5);
      expect(brief.assigneeName).toBe("mover");
      const assigned = app.db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM event WHERE repo_id = ?1 AND kind = 'issue.assigned'",
        )
        .all(repo.id)
        .map((e) => JSON.parse(e.payload) as { number: number; agent?: boolean });
      expect(assigned).toContainEqual(
        expect.objectContaining({ number: 5, agent: true }),
      );
      // And the import said so once, not once per row.
      const imported = app.db
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM event WHERE repo_id = ?1 AND kind = 'repo.imported'",
        )
        .get(repo.id);
      expect(imported?.n).toBe(1);
    } finally {
      github.stop();
    }
  });

  test("a pull opened from a fork arrives with its head under refs/pull/<n>/head, waiting for a writer to let it run", async () => {
    const made = await createRepo(app, octo, { name: "forked-pulls", visibility: "private" });
    if (!made.ok) throw new Error(made.error);
    for (const branch of ["main", "their-work"]) {
      const done = await commitToBranch(app, octo, made.value, {
        branch,
        message: `on ${branch}`,
        files: [{ path: `${branch}.txt`, content: "x\n" }],
      });
      if (!done.ok) throw new Error(String(done.error));
    }
    // The head lives only where GitHub keeps it: refs/pull/<n>/head.
    const upstream = repoDir(app.reposRoot, "octo", "forked-pulls");
    const sha = (await git(["rev-parse", "their-work"], upstream)).out;
    expect((await git(["update-ref", "refs/pull/6/head", sha], upstream)).code).toBe(0);
    expect((await git(["branch", "-D", "their-work"], upstream)).code).toBe(0);
    // A branch of the source's own that happens to be called pull/6.
    const mainSha = (await git(["rev-parse", "main"], upstream)).out;
    expect((await git(["branch", "pull/6", "main"], upstream)).code).toBe(0);

    const state = newFakeState("github", "octo", upstreamSecret);
    state.repos.push({
      id: 801,
      fullName: "octo/forked-pulls",
      cloneUrl: `${base}/octo/forked-pulls.git`,
      defaultBranch: "main",
      private: true,
    });
    state.issues.set("octo/forked-pulls", [
      {
        id: 806,
        number: 6,
        title: "From a fork",
        user: "stranger",
        pull: { base: "main", head: "their-work", headRepo: "stranger/forked-pulls", headSha: sha },
      },
    ]);
    const github = serveFakeForge(state);
    try {
      forgetProviders(dataDir);
      const connected = await connectOrigin(app, alice, {
        host: github.url,
        kind: "github",
        token: upstreamSecret,
      });
      if (!connected.ok) throw new Error(JSON.stringify(connected.error));
      const job = await migrate(alice, {
        source: { originId: connected.value.id, fullName: "octo/forked-pulls" },
      });
      expect(job?.error).toBeUndefined();
      expect(job?.detail).toContain(
        "1 open pull request (1 from forks, waiting for your approval to run here)",
      );
      const repo = getRepo(app.db, "alice", "forked-pulls")!;
      const pull = getPull(app.db, repo.id, 6)!;
      // Still the stranger's: the head is where the forge keeps pull heads,
      // the source's own pull/6 branch is untouched, and no push event
      // carried the stranger's head to a check or a preview.
      expect(pull.originHeadRepo).toBe("stranger/forked-pulls");
      const dir = repoDir(app.reposRoot, "alice", "forked-pulls");
      expect((await git(["rev-parse", "refs/pull/6/head"], dir)).out).toBe(sha);
      expect((await git(["rev-parse", "refs/heads/pull/6"], dir)).out).toBe(mainSha);
      const pushed = app.db
        .query<{ payload: string }, [string]>(
          "SELECT payload FROM event WHERE repo_id = ?1 AND kind = 'push'",
        )
        .all(repo.id)
        .map((e) => JSON.stringify(JSON.parse(e.payload)));
      expect(pushed.length).toBe(1);
      expect(pushed[0]).not.toContain(sha);
      expect(pushed[0]).not.toContain("refs/pull/");
      // It runs only once a writer approves this head.
      const status = await pullStatus(dir, pull);
      expect(status.headOid).toBe(sha);
      expect(pullMayRun(app.db, repo, pull, sha)).toBe(false);
      const approved = await approveHere(app, alice, repo, pull);
      expect(approved.ok).toBe(true);
      expect(pullMayRun(app.db, repo, pull, sha)).toBe(true);
    } finally {
      github.stop();
    }
  });

  test("the app's branch: the person's newest beats the source's default, by URL and from GitHub, and the brief names it", async () => {
    // trevato/arm's shape: `main` is the upstream's tree (and the newest
    // commit), `workbench` is the person's app, ahead of it.
    const upstreamer = await person("upstreamer");
    const made = await createRepo(app, upstreamer, { name: "arm", visibility: "public" });
    if (!made.ok) throw new Error(made.error);
    const put = async (user: User, branch: string, message: string) => {
      const done = await commitToBranch(app, user, made.value, {
        branch,
        message,
        files: [{ path: `${message}.txt`, content: "x\n" }],
      });
      if (!done.ok) throw new Error(String(done.error));
    };
    // Which tip is newer is the rule's own test (work-branch.test.ts);
    // here, whose it is decides.
    await put(upstreamer, "main", "upstream-start");
    await put(alice, "workbench", "the-app");
    await put(upstreamer, "main", "upstream-later");
    const upstream = repoDir(app.reposRoot, "upstreamer", "arm");
    const mainSha = (await git(["rev-parse", "main"], upstream)).out;
    const workSha = (await git(["rev-parse", "workbench"], upstream)).out;
    const agent = await createAgent(app, alice, { username: "armer", model: "", brief: "Moves things in." });
    expect(agent.ok).toBe(true);
    const briefOf = (owner: string, name: string): string =>
      listIssues(app.db, getRepo(app.db, owner, name)!.id, { kind: "issue", state: "open" })
        .find((i) => i.title === `Make ${name} run here`)!.body;

    // By URL, the clone's own authors: alice's branch, not the source's main.
    const byUrl = await migrate(alice, {
      source: { url: `${base}/upstreamer/arm.git` },
      name: "arm-url",
      crew: { agent: "armer", autonomous: false },
    });
    expect(byUrl?.error).toBeUndefined();
    expect(byUrl?.detail).toContain("Working on workbench, the branch with your newest commits");
    expect(getRepo(app.db, "alice", "arm-url")!.defaultBranch).toBe("workbench");
    expect(briefOf("alice", "arm-url")).toContain("The app is on the branch `workbench`");
    expect(briefOf("alice", "arm-url")).toContain("open your pull against it");
    // Someone with no commits there keeps the source's default.
    const theirs = await migrate(bob, { source: { url: `${base}/upstreamer/arm.git` }, name: "arm-bob" });
    expect(getRepo(app.db, "bob", "arm-bob")!.defaultBranch).toBe("main");
    expect(theirs?.detail).toContain("Working on main, the source's default branch");
    // A branch that is not one git would take is refused before anything exists.
    const bad = await migrateRepo(app, alice, {
      source: { url: `${base}/upstreamer/arm.git` },
      name: "arm-bad",
      branch: "--upload-pack=x",
    });
    expect(bad.ok ? "" : bad.error).toBe("invalid_branch");
    expect(getRepo(app.db, "alice", "arm-bad")).toBeUndefined();

    // From GitHub: the origin says whose each last commit is by login.
    const state = newFakeState("github", "octo", upstreamSecret);
    state.repos.push({
      id: 901,
      fullName: "octo/arm",
      cloneUrl: `${base}/upstreamer/arm.git`,
      defaultBranch: "main",
      private: true,
    });
    state.branches.set("octo/arm", [
      { name: "main", sha: mainSha },
      { name: "workbench", sha: workSha },
    ]);
    state.commits.set("octo/arm", [
      { sha: workSha, message: "<b>the app</b>\n\nbody", authorName: "Octo Cat", authorEmail: "octo@laptop.invalid", login: "octo", date: "2026-10-19T12:00:00Z" },
      { sha: mainSha, message: "upstream later", authorName: "Up Streamer", login: "upstreamer", date: "2026-10-20T09:00:00Z" },
    ]);
    const github = serveFakeForge(state);
    try {
      forgetProviders(dataDir);
      const connected = await connectOrigin(app, alice, { host: github.url, kind: "github", token: upstreamSecret });
      if (!connected.ok) throw new Error(JSON.stringify(connected.error));
      const value = `${connected.value.id}/octo/arm`;

      // The row links to its branches; the list shows each last commit,
      // escaped, newest first, and selects the person's.
      const listing = await (await browser(aliceCookie, "/migrate")).text();
      expect(listing).not.toContain('id="migrate-branches"');
      expect(listing).toContain(`href="/migrate?source=${encodeURIComponent(value)}&amp;branches=1#migrate-branches"`);
      // A plain visit with the row selected asks the origin for nothing.
      const asking = () => state.requests.filter((r) => r.path.endsWith("/branches") || r.path.endsWith("/commits")).length;
      const before = asking();
      const plain = await (await browser(aliceCookie, `/migrate?${new URLSearchParams({ source: value })}`)).text();
      expect(plain).not.toContain('id="migrate-branches"');
      expect(asking()).toBe(before);
      const html = await (await browser(aliceCookie, `/migrate?${new URLSearchParams({ source: value, branches: "1" })}`)).text();
      // One listing and one commit per branch; a reload within the minute costs none.
      expect(asking()).toBe(before + 3);
      await browser(aliceCookie, `/migrate?${new URLSearchParams({ source: value, branches: "1" })}`);
      expect(asking()).toBe(before + 3);
      const rows = [...html.matchAll(/data-branch="([^"]+)"/g)].map((m) => m[1]);
      expect(rows).toEqual(["main", "workbench"]);
      expect(html).toMatch(/value="workbench"\s+checked/);
      expect(html).not.toMatch(/value="main"\s+checked/);
      expect(html).toContain("&lt;b&gt;the app&lt;/b&gt;");
      expect(html).not.toContain("<b>the app</b>");
      expect(html).toMatch(/octo ·\s+<time datetime="2026-10-19T12:00:00(\.000)?Z">2026-10-19<\/time>/);
      expect(html).toContain("default there");
      // Asked for, another branch is the one selected.
      const asked = await (await browser(aliceCookie, `/migrate?${new URLSearchParams({ source: value, branch: "main" })}`)).text();
      expect(asked).toMatch(/value="main"\s+checked/);

      // The Migrate button carries the branch chosen.
      const chosen = await browser(aliceCookie, "/migrate", {
        source: value, branch: "main", url: "", owner: "alice", name: "arm-main", visibility: "private", agent: "armer",
      });
      expect(chosen.status).toBe(303);
      const chosenJob = await settled(chosen.headers.get("location")!.split("/").pop()!);
      expect(chosenJob?.detail).toContain("Working on main, the branch picked");
      expect(getRepo(app.db, "alice", "arm-main")!.defaultBranch).toBe("main");
      expect(briefOf("alice", "arm-main")).toContain("The app is on the branch `main` — the branch the person who migrated it picked");

      // Another row's button ignores a branch drawn for a different row:
      // one click migrates by the rule — here, by the origin's login alone,
      // since the clone's author (alice) is not the person connected (octo).
      const oneClick = await browser(aliceCookie, "/migrate", {
        pick: value, source: "elsewhere/x/y", branch: "main", url: "", owner: "alice", name: "arm-click", visibility: "private", agent: "armer",
      });
      expect(oneClick.status).toBe(303);
      const clickJob = await settled(oneClick.headers.get("location")!.split("/").pop()!);
      expect(clickJob?.error).toBeUndefined();
      expect(getRepo(app.db, "alice", "arm-click")!.defaultBranch).toBe("workbench");
      expect(briefOf("alice", "arm-click")).toContain("The app is on the branch `workbench` — the branch with the newest commits of the person who migrated it");
    } finally {
      github.stop();
    }
  }, 30_000);

  test("Connect GitHub from /migrate comes back to /migrate, and so does Disconnect; nothing else can be named", async () => {
    const state = newFakeState("github", "bobby", "bob-gh-token");
    const oauth = newFakeOAuth("migrate-client");
    state.oauth = oauth;
    const github = serveFakeForge(state);
    process.env.FORGE_GITHUB_CLIENT_ID = "migrate-client";
    try {
      forgetProviders(dataDir);
      const page = await (await browser(bobCookie, "/migrate")).text();
      expect(page).toContain('action="/settings/origins/oauth"');
      expect(page).toContain("Connect GitHub");
      // One filled button on the page: Migrate. Connect is an outline.
      expect(page.match(/data-variant="primary"/g)?.length).toBe(1);
      expect(page).toMatch(/data-variant="outline"[^>]*>\s*(<svg[\s\S]*?<\/svg>)?\s*Connect GitHub/);

      const started = await browser(bobCookie, "/settings/origins/oauth", {
        kind: "github",
        host: github.url,
        then: "migrate",
      });
      expect(started.status).toBe(303);
      const flowPage = started.headers.get("location")!;
      expect(flowPage).toMatch(/^\/settings\/origins\/flows\/[^?]+\?then=migrate$/);
      const waiting = await (await browser(bobCookie, flowPage)).text();
      expect(waiting).toContain("WXYZ-1234");
      expect(waiting).toContain("/poll?then=migrate");

      oauth.approved = true;
      const flowId = flowPage.split("/").pop()!.split("?")[0]!;
      const polled = await browser(
        bobCookie,
        `/settings/origins/flows/${flowId}/poll?then=migrate`,
        {},
      );
      expect(polled.headers.get("location")).toBe("/migrate?connected=1");
      const origin = listOrigins(app.db, bob.id).find((o) => o.kind === "github")!;
      expect(origin).toBeDefined();

      // Connected: the page lists the account and offers Disconnect, not Connect.
      const after = await (await browser(bobCookie, "/migrate?connected=1")).text();
      expect(after).toContain('id="migrate-connected"');
      expect(after).toContain(`action="/settings/origins/${origin.id}/delete"`);
      expect(after).not.toContain('action="/settings/origins/oauth"');

      // `then` is a word, not an address: anything else goes home.
      const steered = await browser(bobCookie, "/settings/origins/oauth", {
        kind: "github",
        host: github.url,
        then: "https://evil.test/",
      });
      expect(steered.headers.get("location")).not.toContain("then=");

      const gone = await browser(bobCookie, `/settings/origins/${origin.id}/delete`, {
        then: "migrate",
      });
      expect(gone.status).toBe(303);
      expect(gone.headers.get("location")).toBe("/migrate");
      expect(listOrigins(app.db, bob.id).some((o) => o.id === origin.id)).toBe(false);
    } finally {
      delete process.env.FORGE_GITHUB_CLIENT_ID;
      github.stop();
    }
  });

  test("the picker's pieces: sizes in binary units, a filter on name or description, a backlink that cannot be steered", () => {
    expect(formatKib(0)).toBe("");
    expect(formatKib(512)).toBe("512 KiB");
    expect(formatKib(1536)).toBe("1.5 MiB");
    expect(formatKib(20 * 1024)).toBe("20 MiB");
    expect(formatKib(3 * 1024 * 1024)).toBe("3.0 GiB");
    expect(matchesFilter({ fullName: "octo/Gadgets", description: "" }, "gadg")).toBe(true);
    expect(matchesFilter({ fullName: "octo/x", description: "Small machines" }, "MACHINE")).toBe(true);
    expect(matchesFilter({ fullName: "octo/x", description: "" }, "y")).toBe(false);

    expect(
      backlink({ number: 7, author: "mona", htmlUrl: "https://github.com/o/r/issues/7" }, "o/r", "GitHub"),
    ).toBe("> Migrated from [o/r#7](https://github.com/o/r/issues/7) by @mona on GitHub.");
    // A link that is not http(s) is named, not linked; a login cannot
    // smuggle markdown or a mention of someone else.
    const hostile = backlink(
      { number: 7, author: "x](javascript:alert(1)) @admin", htmlUrl: "javascript:alert(1)" },
      "o/r",
      "GitHub",
    );
    expect(hostile).not.toContain("javascript:");
    expect(hostile).not.toContain("](");
    expect(hostile).toBe("> Migrated from o/r#7 by @xjavascriptalert1admin on GitHub.");
  });

  test("the page: the form, the plus menu, the job, and who may see it", async () => {
    const anonymous = await browser("", "/migrate");
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toStartWith("/signin");

    const html = await (await browser(aliceCookie, "/migrate")).text();
    expect(html).toContain('action="/migrate"');
    expect(html).toContain('name="url"');
    // Each repository is a row whose button is the form's submitter.
    expect(html).toMatch(/name="pick"\s+value="[^"]+\/octo\/secret-widgets"/);
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

  test("the job page follows its stages over the stream, with no meta refresh", async () => {
    const follow = async (end: Partial<Parameters<typeof advance>[1]>) => {
      const job = createJob("", "octo/streamed", {
        kind: "migrate",
        actorId: alice.id,
      });
      const page = await (
        await browser(aliceCookie, `/migrate/jobs/${job.id}`)
      ).text();
      expect(page).not.toContain('http-equiv="refresh"');
      expect(page).toContain(`data-job="${job.id}"`);
      expect(page).toContain("<noscript>");
      expect(page).toContain("Reload");
      const streamPath = `/api/v1/migrate/${job.id}/stream`;
      // Another person's stream is not found, as their page is.
      expect((await browser(bobCookie, streamPath)).status).toBe(404);
      const res = await browser(aliceCookie, streamPath);
      expect(res.status).toBe(200);
      advance(job.id, { stage: "fetching", detail: "receiving 61%" });
      advance(job.id, end);
      // The stream ends itself on a terminal stage.
      const text = await new Response(res.body).text();
      return { job, text };
    };

    const ok = await follow({ stage: "done", detail: "migrated" });
    expect(ok.text).toContain("event: migrate.creating");
    expect(ok.text).toContain("event: migrate.fetching");
    expect(ok.text).toContain("event: migrate.done");

    const bad = await follow({ stage: "failed", error: "clone went wrong" });
    expect(bad.text).toContain("event: migrate.fetching");
    expect(bad.text).toContain("event: migrate.failed");
    expect(bad.text).toContain("clone went wrong");
    // Failed is a page that stands, with the reason, and no stream of its own.
    const stands = await (
      await browser(aliceCookie, `/migrate/jobs/${bad.job.id}`)
    ).text();
    expect(stands).toContain("clone went wrong");
    expect(stands).not.toContain("error-note");
    expect(stands).toMatch(
      /<div class="field" data-invalid>\s*<span class="error" role="alert"[^>]*>clone went wrong/,
    );
    expect(stands).not.toContain("EventSource");
    expect(stands).not.toContain('http-equiv="refresh"');
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
    expect(hit).toMatch(/name="source" value="[^"]+\/octo\/secret-widgets"/);
    expect(hit).toMatch(/aria-current="true"/);
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
    expect(miss).not.toContain('name="source" value=');
    expect(miss).not.toContain('aria-current="true"');

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

  test("a name that resolves to a private address is refused like the literal", async () => {
    const config = app.config as { migrateFromPrivateHosts?: boolean };
    config.migrateFromPrivateHosts = false;
    try {
      const refused = await migrateRepo(app, bob, {
        source: { url: "https://looks-public.example/a/b.git" },
        resolve: async () => ["10.0.0.5"],
      });
      expect(refused).toEqual({ ok: false, error: "private_host" });
    } finally {
      config.migrateFromPrivateHosts = true;
    }
  });

  test("a vetted host is pinned to the vetted address; a trusted one is not", async () => {
    const config = app.config as { migrateFromPrivateHosts?: boolean };
    config.migrateFromPrivateHosts = false;
    try {
      const source = { url: "https://looks-public.example/a/b.git" };
      const resolved = await resolveSource(app, bob, source, async () => ["93.184.216.34"]);
      if (!resolved.ok) throw new Error("expected a resolved source");
      const env = fetchEnv(resolved.value, {});
      const pins = Object.entries(env).filter(([, v]) => v.startsWith("looks-public.example:443:"));
      expect(pins).toEqual([[expect.any(String), "looks-public.example:443:93.184.216.34"]]);
      expect(env["GIT_ALLOW_PROTOCOL"]).toBe("https:http");
      // A host that does not resolve is not fetched unpinned.
      const lost = await resolveSource(app, bob, source, async () => []);
      expect(lost).toEqual({ ok: false, error: "unreachable" });
    } finally {
      config.migrateFromPrivateHosts = true;
    }
    // No vetting (the caller may reach private hosts), so no pin.
    const open = await resolveSource(app, bob, { url: "https://looks-public.example/a/b.git" });
    if (!open.ok) throw new Error("expected a resolved source");
    expect(Object.values(fetchEnv(open.value, {})).some((v) => v.includes(":443:"))).toBe(false);
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

  test("the job page draws each stage as a row with a state badge, and no stage-dot", async () => {
    const job = createJob("", "octo/rows", { kind: "migrate", actorId: alice.id });
    advance(job.id, { stage: "fetching", detail: "receiving 61%" });
    const page = await (await browser(aliceCookie, `/migrate/jobs/${job.id}`)).text();
    expect(page).not.toContain("stage-dot");
    expect(page).not.toContain("stage-detail");
    // The page's script is built from the table the rows are drawn from.
    expect(await withScripts(servers.url, page)).toContain(`var badges = ${STAGE_BADGE_JS};`);
    expect(page).toMatch(/<li data-stage-name="creating" data-state="done">[\s\S]*?class="row"[\s\S]*?>Done</);
    expect(page).toMatch(/data-stage-name="fetching" data-state="now">[\s\S]*?receiving 61%[\s\S]*?>Running</);
    expect(page).toMatch(/data-stage-name="crew" data-state="todo">[\s\S]*?>Waiting</);
    expect(page).toMatch(/<ol class="list stages" aria-live="polite">/);
    // Every stage has a `.row-meta` for the live update to write into.
    const items = page.match(/<li data-stage-name=[\s\S]*?<\/li>/g) ?? [];
    expect(items.length).toBeGreaterThan(0);
    for (const li of items) expect(li).toContain('class="row-meta"');
  });

  test("mark the stage it failed on, and keep the earlier ones done", async () => {
    const job = createJob("", "octo/broke", { kind: "migrate", actorId: alice.id });
    advance(job.id, { stage: "fetching", detail: "receiving 3%" });
    advance(job.id, { stage: "failed", error: "clone went wrong" });
    const page = await (await browser(aliceCookie, `/migrate/jobs/${job.id}`)).text();
    expect(page).toMatch(/data-stage-name="creating" data-state="done"/);
    expect(page).toMatch(/data-stage-name="fetching" data-state="failed">[\s\S]*?data-variant="danger"\s*>Failed</);
    expect(page).toMatch(/data-stage-name="crew" data-state="todo"/);
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
