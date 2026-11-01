import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { getUserByName, type User } from "../src/core/users.ts";
import {
  runningJob,
  settled,
  subscribe,
  type MirrorStage,
} from "../src/origins/jobs.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import {
  clearViewCache,
  ViewCache,
  viewCache,
  cacheKey,
} from "../src/view/cache.ts";
import { sourceFor, type RepoSource } from "../src/view/source.ts";
import {
  newFakeState,
  serveFakeForge,
  type FakeForge,
} from "./fake-origin.ts";
import { fastFirstFetch, mirrorOutbound } from "./helpers/globals.ts";
import { seedAdmin } from "./helpers/admin.ts";

/**
 * Browsing before mirroring.
 *
 * The claim under test is that one interface (`RepoSource`) answers the same
 * questions with the same shapes whether the bytes come from a bare repo
 * here or from an API on another forge — because two UIs are about to be
 * written against it, and the whole point is that neither has to know.
 *
 * So the centrepiece is an equivalence test: mirror a repository, then ask
 * the live source and the local source the same questions and compare the
 * answers. Around it are the properties a live browse has to hold anyway —
 * it is read-only, it is cached, it is bounded, it is somebody's private
 * business, and it fails as a value rather than a crash.
 */

const ORIGIN_LOGIN = "octo";
const ORIGIN_TOKEN = "octo-origin-secret-4b81";
const ALICE_PASSWORD = "alice-login-secret";
const BOB_PASSWORD = "bob-login-secret";
const README = "# widgets\nhello\n";
const SOURCE_FILE = "export const gears = 3;\n";

const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

const read = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

const text = (body: Uint8Array): string => new TextDecoder().decode(body);

// A fetch that fails should say so now, not after the forge's patience.
fastFirstFetch();
// Both origins are on loopback. Asked for here, not inherited, so a file
// earlier in the shard that left the vet tightened cannot refuse them (#7686).
mirrorOutbound({ allow: ["127.0.0.1", "::1"] });

// A test that runs a whole mirror spawns real git against a second forge and
// then imports: ~0.2 s idle, past 2 s on a machine three times oversubscribed.
// Bun's 5 s default would make the verdict a measure of the check machine's
// load; what these tests judge is the order and the outcome, not the speed.
const MIRROR_MS = 60_000;

describe("RepoSource: one repository, two places to read it from", () => {
  let dataDir: string;
  let originDataDir: string;
  let app: App;
  let servers: Servers;
  let originApp: App;
  let originServers: Servers;
  let fake: FakeForge;
  let base: string;
  let originId = "";
  let alice: User;
  let bob: User;

  const api = (
    path: string,
    init?: RequestInit & { as?: "alice" | "bob"; token?: string },
  ) => {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined)
      headers.set("content-type", "application/json");
    if (init?.token !== undefined)
      headers.set("authorization", `Bearer ${init.token}`);
    else if (init?.as === "bob")
      headers.set("authorization", basic("bob", BOB_PASSWORD));
    else headers.set("authorization", basic("alice", ALICE_PASSWORD));
    return fetch(`${base}${path}`, { ...init, headers });
  };

  /** A live source for a repo on the origin, as its owner sees it. */
  const live = (fullName: string, actor: User = alice): RepoSource => {
    const source = sourceFor(app, actor, { originId, fullName });
    if (!source.ok) throw new Error(`no source: ${source.error}`);
    return source.value;
  };

  const local = (owner: string, name: string): RepoSource => {
    const source = sourceFor(app, alice, { owner, name });
    if (!source.ok) throw new Error(`no source: ${source.error}`);
    return source.value;
  };

  const requests = (): number => fake.state.requests.length;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-view-"));
    originDataDir = await mkdtemp(join(tmpdir(), "forge-view-up-"));

    // A second real forge, so the mirror's git fetch speaks real smart HTTP.
    originApp = createApp({ dataDir: originDataDir, port: 0 });
    originServers = await serve(originApp);
    const up = (path: string, body: unknown, auth = true) =>
      fetch(`${originServers.url}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: basic(ORIGIN_LOGIN, ORIGIN_TOKEN) } : {}),
        },
        body: JSON.stringify(body),
      });
    await seedAdmin(originApp, {
      username: ORIGIN_LOGIN,
      email: "octo@upstream.test",
      password: ORIGIN_TOKEN,
    });
    await up("/api/v1/repos", { name: "widgets", visibility: "public" });
    await up("/api/v1/repos/octo/widgets/contents", {
      branch: "main",
      message: "first",
      files: [
        { path: "README.md", content: README },
        { path: "src/index.ts", content: SOURCE_FILE },
      ],
    });
    const upstreamCommits = (await (
      await fetch(`${originServers.url}/api/v1/repos/octo/widgets/commits`)
    ).json()) as { oid: string; subject: string }[];

    // The fake Forgejo API in front of it, describing the same repository —
    // the same files, the same log, so "equivalent" is a claim with teeth.
    const state = newFakeState("forgejo", ORIGIN_LOGIN, ORIGIN_TOKEN);
    state.repos.push(
      {
        id: 41,
        fullName: "octo/widgets",
        description: "gears and things",
        cloneUrl: `${originServers.url}/octo/widgets.git`,
        htmlUrl: `${originServers.url}/octo/widgets`,
        defaultBranch: "main",
      },
      {
        id: 42,
        fullName: "octo/hidden",
        description: "not for everyone",
        private: true,
        cloneUrl: `${originServers.url}/octo/hidden.git`,
        defaultBranch: "main",
      },
      {
        id: 43,
        fullName: "octo/ghost",
        description: "a repo whose git side is not there",
        cloneUrl: `${originServers.url}/octo/ghost.git`,
        defaultBranch: "main",
      },
      {
        id: 44,
        fullName: "octo/heavy",
        description: "one very large file",
        cloneUrl: `${originServers.url}/octo/heavy.git`,
        defaultBranch: "main",
      },
    );
    state.files.set(
      "octo/widgets",
      new Map([
        ["README.md", README],
        ["src/index.ts", SOURCE_FILE],
      ]),
    );
    state.files.set("octo/hidden", new Map([["README.md", "# hidden\n"]]));
    // Over the megabyte cap: the origin answers with no body at all, which
    // is the case a browse must survive without holding the file.
    state.files.set(
      "octo/heavy",
      new Map([["big.bin", "x".repeat(1024 * 1024 + 10)]]),
    );
    state.branches.set("octo/widgets", [
      { name: "main", sha: upstreamCommits[0]!.oid, protected: true },
    ]);
    state.tags.set("octo/widgets", [
      { name: "v1", sha: upstreamCommits[0]!.oid },
    ]);
    state.commits.set("octo/widgets", [
      {
        sha: upstreamCommits[0]!.oid,
        message: "first\n\nthe body of it",
        authorName: "Mona Lisa",
        login: "mona",
        date: "2026-01-01T00:00:00.000Z",
        diff: [
          "diff --git a/README.md b/README.md",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/README.md",
          "@@ -0,0 +1,2 @@",
          "+# widgets",
          "+hello",
          "",
        ].join("\n"),
      },
    ]);
    state.labels.set("octo/widgets", [
      { id: 1, name: "bug", color: "d73a4a" },
      { id: 2, name: "chore", color: "cfd3d7" },
    ]);
    state.issues.set("octo/widgets", [
      {
        id: 900,
        number: 7,
        title: "The gear slips",
        body: "under load",
        user: "mona",
        labels: ["bug"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        id: 901,
        number: 9,
        title: "Tighten the bolt",
        user: "hubot",
        createdAt: "2026-01-03T00:00:00.000Z",
        updatedAt: "2026-01-03T00:00:00.000Z",
        pull: {
          base: "main",
          head: "tighten",
          headRepo: "octo/widgets",
          mergedAt: null,
        },
      },
    ]);
    state.comments.set("octo/widgets", [
      {
        id: 500,
        issueNumber: 7,
        body: "seen it too",
        user: "mona",
        createdAt: "2026-01-02T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
    state.pullDiffs.set(
      "octo/widgets#9",
      [
        "diff --git a/src/index.ts b/src/index.ts",
        "--- a/src/index.ts",
        "+++ b/src/index.ts",
        "@@ -1 +1 @@",
        "-export const gears = 3;",
        "+export const gears = 4;",
        "",
      ].join("\n"),
    );
    fake = serveFakeForge(state);

    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: ALICE_PASSWORD });
    await fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bob", email: "bob@forge.test", password: BOB_PASSWORD }),
    });
    alice = getUserByName(app.db, "alice")!;
    bob = getUserByName(app.db, "bob")!;

    const connected = await api("/api/v1/user/origins", {
      method: "POST",
      body: JSON.stringify({ host: fake.url, token: ORIGIN_TOKEN }),
    });
    expect(connected.status).toBe(201);
    originId = (await read<{ id: string }>(connected)).id;
    clearViewCache();
  });

  afterAll(async () => {
    fake.stop();
    servers.stop();
    originServers.stop();
    app.close();
    originApp.close();
    forgetProviders(dataDir);
    clearViewCache();
    await rm(dataDir, { recursive: true, force: true });
    await rm(originDataDir, { recursive: true, force: true });
  });

  // ---- the live browse ----

  test("a repository on the origin reads before anything is mirrored", async () => {
    const source = live("octo/widgets");
    expect(source.where.kind).toBe("origin");
    // Nothing local exists yet — this is the whole point of the feature.
    expect(app.db.query("SELECT 1 FROM repo").all().length).toBe(0);

    const facts = await source.describe();
    expect(facts.ok && facts.value).toMatchObject({
      owner: "octo",
      name: "widgets",
      description: "gears and things",
      visibility: "public",
      defaultBranch: "main",
    });

    // The origin's own answer to "may I push here?" — the question that
    // decides between editing through a mirror and contributing via a fork.
    expect(facts.ok && facts.value.permissions).toEqual({ push: true });

    const branches = await source.branches();
    expect(branches.ok && branches.value.map((b) => b.name)).toEqual(["main"]);
    expect(branches.ok && branches.value[0]!.isDefault).toBe(true);

    const tags = await source.tags();
    expect(tags.ok && tags.value.map((t) => t.name)).toEqual(["v1"]);

    const readme = await source.readme("main");
    expect(readme.ok && readme.value).toMatchObject({
      path: "README.md",
      markdown: README,
    });
  });

  test("a live browse is read-only, in the type and on the wire", async () => {
    const before = requests();
    const source = live("octo/widgets");
    expect(source.capabilities.write).toBe(false);
    expect(source.capabilities.pin).toBe(false);
    expect(source.capabilities.mirror).toBe(true);

    await source.tree("main", "");
    await source.issues({ kind: "issue", state: "all" });
    await source.labels();
    // Every request the browse made was a read. Nothing on this interface
    // can write, and nothing it does upstream does either.
    for (const request of fake.state.requests.slice(before))
      expect(request.method).toBe("GET");
  });

  test("a commit and its diff come back parsed, not as text", async () => {
    const source = live("octo/widgets");
    const page = await source.commits("main");
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.items).toHaveLength(1);
    const commit = page.value.items[0]!;
    expect(commit.subject).toBe("first");
    expect(commit.body).toBe("the body of it");
    expect(commit.login).toBe("mona");
    expect(commit.author).toBe("Mona Lisa");

    const detail = await source.commit(commit.oid);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.value.diff.files.map((f) => f.path)).toEqual(["README.md"]);
    expect(detail.value.diff.additions).toBe(2);
  });

  test("a pull carries its diff; an issue carries its comments", async () => {
    const source = live("octo/widgets");
    const issue = await source.issue(7);
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;
    expect(issue.value.issue.title).toBe("The gear slips");
    expect(issue.value.issue.originAuthor).toBe("mona");
    expect(issue.value.issue.labels.map((l) => l.name)).toEqual(["bug"]);
    // The label's colour came from the repo's label list, not a default.
    expect(issue.value.issue.labels[0]!.color).toBe("d73a4a");
    expect(issue.value.comments.map((c) => c.body)).toEqual(["seen it too"]);
    expect(issue.value.pull).toBeNull();

    const pull = await source.issue(9);
    expect(pull.ok).toBe(true);
    if (!pull.ok) return;
    expect(pull.value.pull?.baseBranch).toBe("main");
    expect(pull.value.pull?.headBranch).toBe("tighten");
    expect(pull.value.pull?.diff?.files.map((f) => f.path)).toEqual([
      "src/index.ts",
    ]);
    // Mergeability is the origin's to decide and it does not say, so we do
    // not guess.
    expect(pull.value.pull?.mergeable).toBeNull();
    // The verdicts come through the same shape either side answers from;
    // this origin has none on this pull, and none is an empty list, not a
    // missing key a surface has to guard.
    expect(pull.value.pull?.reviews).toEqual([]);
  });

  test("a blob past the cap is too_large, with no body held", async () => {
    const source = live("octo/heavy");
    const blob = await source.blob("main", "big.bin");
    expect(blob.ok).toBe(true);
    if (!blob.ok) return;
    expect(blob.value.kind).toBe("too_large");
    if (blob.value.kind !== "too_large") return;
    expect(blob.value.size).toBeGreaterThan(1024 * 1024);
  });

  test("a private repo on the origin is browsable by the account that connected it", async () => {
    const source = live("octo/hidden");
    const facts = await source.describe();
    expect(facts.ok && facts.value.visibility).toBe("private");
    const tree = await source.tree("main", "");
    expect(tree.ok && tree.value.map((e) => e.name)).toEqual(["README.md"]);
  });

  test("nobody else's origin exists, and neither does browsing through it", async () => {
    const before = requests();
    expect(sourceFor(app, bob, { originId, fullName: "octo/widgets" })).toEqual(
      { ok: false, error: "not_found" },
    );
    // Anonymous, too: an origin is one person's connected account.
    expect(
      sourceFor(app, undefined, { originId, fullName: "octo/widgets" }),
    ).toEqual({ ok: false, error: "not_found" });
    // Refused before a single request left this forge.
    expect(requests()).toBe(before);
  });

  test("a rate-limited origin is a value, not a crash", async () => {
    clearViewCache();
    fake.state.rateLimitFor = 3;
    const source = live("octo/widgets");
    const facts = await source.describe();
    fake.state.rateLimitFor = 0;
    expect(facts).toEqual({ ok: false, error: "rate_limited" });
  });

  // ---- the cache ----

  test("a second identical read does not reach the origin", async () => {
    clearViewCache();
    const source = live("octo/widgets");
    const before = requests();
    const first = await source.tree("main", "");
    const spent = requests() - before;
    expect(spent).toBeGreaterThan(0);

    const second = await source.tree("main", "");
    expect(requests()).toBe(before + spent);
    expect(second).toEqual(first);

    // A different argument is a different key, and does reach the origin.
    await source.tree("main", "src");
    expect(requests()).toBeGreaterThan(before + spent);
  });

  test("the cache is keyed per origin, repo, method and arguments", () => {
    const scope = { originId: "o1", fullName: "octo/Widgets" };
    // Case-insensitive on the repo name: `octo/Widgets` and `octo/widgets`
    // are one repository, and a bust must reach both.
    expect(cacheKey(scope, "tree", "main", "")).toBe(
      cacheKey(
        { originId: "o1", fullName: "octo/widgets" },
        "tree",
        "main",
        "",
      ),
    );
    expect(cacheKey(scope, "tree", "main", "")).not.toBe(
      cacheKey(scope, "tree", "main", "src"),
    );
    expect(cacheKey(scope, "tree", "main", "")).not.toBe(
      cacheKey(
        { originId: "o2", fullName: "octo/widgets" },
        "tree",
        "main",
        "",
      ),
    );
  });

  test("entries expire, evict, and can be busted by repo", () => {
    let now = 1_000;
    const cache = new ViewCache({
      now: () => now,
      maxEntries: 3,
      maxBytes: 100,
    });
    const scope = { originId: "o1", fullName: "octo/widgets" };

    cache.set(cacheKey(scope, "a"), "one", 60_000);
    expect(cache.get<unknown>(cacheKey(scope, "a"))).toBe("one");
    now += 59_000;
    expect(cache.get<unknown>(cacheKey(scope, "a"))).toBe("one");
    now += 2_000;
    // Past its TTL it is gone, and gone from the accounting too.
    expect(cache.get<unknown>(cacheKey(scope, "a"))).toBeUndefined();
    expect(cache.stats().entries).toBe(0);

    // Bounded by count: the oldest goes.
    for (const key of ["b", "c", "d", "e"])
      cache.set(cacheKey(scope, key), key, 60_000);
    expect(cache.stats().entries).toBe(3);
    expect(cache.get<unknown>(cacheKey(scope, "b"))).toBeUndefined();
    expect(cache.get<unknown>(cacheKey(scope, "e"))).toBe("e");

    // Bounded by bytes: a blob budget is what stops an LRU being a leak.
    cache.clear();
    cache.set(cacheKey(scope, "big"), "x", 60_000, 60);
    cache.set(cacheKey(scope, "big2"), "y", 60_000, 60);
    expect(cache.stats().bytes).toBeLessThanOrEqual(100);
    expect(cache.get<unknown>(cacheKey(scope, "big"))).toBeUndefined();
    // One value larger than the whole budget is never admitted.
    cache.set(cacheKey(scope, "huge"), "z", 60_000, 1_000);
    expect(cache.get<unknown>(cacheKey(scope, "huge"))).toBeUndefined();

    // Busting one repo leaves another origin's rows alone.
    cache.clear();
    cache.set(cacheKey(scope, "keep"), 1, 60_000);
    cache.set(
      cacheKey({ originId: "o2", fullName: "octo/widgets" }, "keep"),
      2,
      60_000,
    );
    expect(cache.bust("o1", "octo/widgets")).toBe(1);
    expect(cache.get<unknown>(cacheKey(scope, "keep"))).toBeUndefined();
    expect(
      cache.get<unknown>(
        cacheKey({ originId: "o2", fullName: "octo/widgets" }, "keep"),
      ),
    ).toBe(2);
  });

  // ---- mirroring, with something to watch ----

  test("a mirror reports its stages in order and ends holding the repo", async () => {
    // Pin the job before its label import until we are subscribed: a
    // subscriber replays only the stage the job is on, so on a loaded machine
    // a job that raced ahead of the subscription would show just "done".
    let release = (): void => {};
    fake.state.holdLabels = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = await api(`/api/v1/user/origins/${originId}/mirror`, {
      method: "POST",
      body: JSON.stringify({ fullName: "octo/widgets" }),
    });
    expect(started.status).toBe(202);
    const job = (await read<{ job: { id: string; stage: MirrorStage } }>(started))
      .job;
    expect(job.stage).toBe("creating");

    // "creating" was observed in the 202; the subscription sees the rest.
    const seen: MirrorStage[] = [job.stage];
    const stop = subscribe(job.id, (update) => {
      if (seen[seen.length - 1] !== update.stage) seen.push(update.stage);
    });
    release();
    const finished = await settled(job.id);
    stop();
    fake.state.holdLabels = undefined;

    expect(finished?.stage).toBe("done");
    expect(finished?.repo?.name).toBe("widgets");
    expect(finished?.finishedAt).toBeString();
    // Stages only ever move forward through the canonical order.
    const order: MirrorStage[] = [
      "creating",
      "fetching",
      "labels",
      "issues",
      "pulls",
      "comments",
      "done",
    ];
    expect(seen[0]).toBe("creating");
    expect(seen[seen.length - 1]).toBe("done");
    expect(seen).toEqual(
      [...seen].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
    );
    // And they carried something to read: "2 labels", "1 issue", …
    expect(seen).toContain("issues");
  }, MIRROR_MS);

  test("mirroring busts what the browse cache believed", async () => {
    const source = live("octo/widgets");
    // The mirror above ran after the cache was warmed by earlier reads.
    const before = requests();
    await source.tree("main", "");
    expect(requests()).toBeGreaterThan(before);
    // And the live source now knows a mirror exists.
    const after = live("octo/widgets");
    expect(after.capabilities.mirror).toBe(false);
    expect(after.where.kind === "origin" && after.where.mirroredAs?.name).toBe(
      "widgets",
    );
  });

  test("a second start joins the job already running", async () => {
    // `octo/ghost`'s git side does not exist upstream, so its fetch takes
    // long enough to still be in flight — and either way, two starts must
    // never produce two clones.
    const first = await api(`/api/v1/user/origins/${originId}/mirror`, {
      method: "POST",
      body: JSON.stringify({ fullName: "octo/ghost" }),
    });
    const second = await api(`/api/v1/user/origins/${originId}/mirror`, {
      method: "POST",
      body: JSON.stringify({ fullName: "octo/ghost" }),
    });
    const a = (await read<{ job: { id: string } }>(first)).job;
    const b = (await read<{ job: { id: string } }>(second)).job;
    expect(b.id).toBe(a.id);
    await settled(a.id);
    // One repository, not two.
    expect(
      app.db
        .query<
          { n: number },
          [string]
        >("SELECT COUNT(*) AS n FROM repo WHERE origin_full_name = ?1")
        .get("octo/ghost")!.n,
    ).toBe(1);
  }, MIRROR_MS);

  test("a failed fetch lands in the job and in fetch_error, scrubbed", async () => {
    const job = await settled(
      (
        await read<{ job: { id: string } }>(
          await api(`/api/v1/user/origins/${originId}/mirror`, {
            method: "POST",
            body: JSON.stringify({ fullName: "octo/ghost", name: "ghost2" }),
          }),
        )
      ).job.id,
    );
    // The repo already exists from the previous test, so this one is refused
    // outright — the failure is on the job either way, never thrown.
    expect(job?.stage).toBe("failed");
    expect(job?.error).toBeString();
    expect(job?.error).not.toContain(ORIGIN_TOKEN);

    // And the first attempt's fetch failure is recorded where a repo page
    // will find it.
    const row = app.db
      .query<
        { fetch_error: string },
        [string]
      >("SELECT fetch_error FROM repo WHERE origin_full_name = ?1")
      .get("octo/ghost")!;
    expect(row.fetch_error).not.toBe("");
    expect(row.fetch_error).not.toContain(ORIGIN_TOKEN);
  }, MIRROR_MS);

  // ---- the equivalence that makes the interface worth having ----

  test("the mirror and the origin answer the same questions the same way", async () => {
    // Compare against the finished mirror: if the test that started it ran
    // out of time on a loaded machine, its import may still be running.
    const importing = runningJob(originId, "octo/widgets");
    if (importing !== undefined) await settled(importing.id);
    const here = local("alice", "widgets");
    const there = live("octo/widgets");
    expect(here.where.kind).toBe("local");
    expect(there.where.kind).toBe("origin");

    // Both sides answer "may I push here?", each from what it knows: the
    // local source from `canWrite`, the live one from the origin's word.
    const [hereFacts, thereFacts] = await Promise.all([
      here.describe(),
      there.describe(),
    ]);
    expect(hereFacts.ok && hereFacts.value.permissions).toEqual({ push: true });
    expect(thereFacts.ok && thereFacts.value.permissions).toEqual({
      push: true,
    });

    // Every path, flat — the file finder's feed — agrees in content and order
    // once sorted, and neither side hit its cap on a small repo.
    const [herePaths, therePaths] = await Promise.all([
      here.paths("main"),
      there.paths("main"),
    ]);
    expect(herePaths.ok && therePaths.ok).toBe(true);
    if (!herePaths.ok || !therePaths.ok) return;
    expect([...therePaths.value.paths].sort()).toEqual(
      [...herePaths.value.paths].sort(),
    );
    expect(herePaths.value.truncated).toBe(false);
    expect(therePaths.value.truncated).toBe(false);
    expect(herePaths.value.paths.length).toBeGreaterThan(0);

    // The tree: same names, same kinds, same order.
    const [hereTree, thereTree] = await Promise.all([
      here.tree("main", ""),
      there.tree("main", ""),
    ]);
    expect(hereTree.ok && thereTree.ok).toBe(true);
    if (!hereTree.ok || !thereTree.ok) return;
    expect(thereTree.value.map((e) => [e.name, e.type])).toEqual(
      hereTree.value.map((e) => [e.name, e.type]),
    );

    // A file: same kind, same bytes, same size.
    const [hereBlob, thereBlob] = await Promise.all([
      here.blob("main", "README.md"),
      there.blob("main", "README.md"),
    ]);
    expect(hereBlob.ok && thereBlob.ok).toBe(true);
    if (!hereBlob.ok || !thereBlob.ok) return;
    expect(thereBlob.value.kind).toBe(hereBlob.value.kind);
    if (
      hereBlob.value.kind === "too_large" ||
      thereBlob.value.kind === "too_large"
    )
      throw new Error("a README should not be too large");
    expect(text(thereBlob.value.body)).toBe(text(hereBlob.value.body));
    expect(thereBlob.value.size).toBe(hereBlob.value.size);

    // The readme, rendered from the same markdown.
    const [hereReadme, thereReadme] = await Promise.all([
      here.readme("main"),
      there.readme("main"),
    ]);
    expect(thereReadme.ok && thereReadme.value).toEqual(
      hereReadme.ok ? hereReadme.value : null,
    );

    // The log: the same commit, by the same id and subject. (The author is
    // the forge's own committer locally and the origin's account live —
    // that difference is the provenance, not a disagreement.)
    const [hereLog, thereLog] = await Promise.all([
      here.commits("main"),
      there.commits("main"),
    ]);
    expect(hereLog.ok && thereLog.ok).toBe(true);
    if (!hereLog.ok || !thereLog.ok) return;
    expect(thereLog.value.items[0]!.oid).toBe(hereLog.value.items[0]!.oid);
    expect(thereLog.value.items[0]!.subject).toBe(
      hereLog.value.items[0]!.subject,
    );

    // The conversations: same numbers, titles, states, labels, authors.
    const shape = (page: {
      items: readonly {
        number: number;
        title: string;
        state: string;
        originAuthor: string | null;
        labels: readonly { name: string }[];
      }[];
    }) =>
      page.items.map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        originAuthor: i.originAuthor,
        labels: i.labels.map((l) => l.name),
      }));
    const [hereIssues, thereIssues] = await Promise.all([
      here.issues({ kind: "issue", state: "all" }),
      there.issues({ kind: "issue", state: "all" }),
    ]);
    expect(hereIssues.ok && thereIssues.ok).toBe(true);
    if (!hereIssues.ok || !thereIssues.ok) return;
    expect(shape(thereIssues.value)).toEqual(shape(hereIssues.value));

    const [herePulls, therePulls] = await Promise.all([
      here.issues({ kind: "pull", state: "all" }),
      there.issues({ kind: "pull", state: "all" }),
    ]);
    expect(herePulls.ok && therePulls.ok).toBe(true);
    if (!herePulls.ok || !therePulls.ok) return;
    expect(shape(therePulls.value)).toEqual(shape(herePulls.value));

    // One conversation, whole: body, comments, and their provenance.
    const [hereIssue, thereIssue] = await Promise.all([
      here.issue(7),
      there.issue(7),
    ]);
    expect(hereIssue.ok && thereIssue.ok).toBe(true);
    if (!hereIssue.ok || !thereIssue.ok) return;
    expect(thereIssue.value.body).toBe(hereIssue.value.body);
    expect(thereIssue.value.comments.map((c) => c.body)).toEqual(
      hereIssue.value.comments.map((c) => c.body),
    );
    expect(thereIssue.value.comments.map((c) => c.originAuthor)).toEqual(
      hereIssue.value.comments.map((c) => c.originAuthor),
    );

    // The labels, by name and colour.
    const [hereLabels, thereLabels] = await Promise.all([
      here.labels(),
      there.labels(),
    ]);
    expect(hereLabels.ok && thereLabels.ok).toBe(true);
    if (!hereLabels.ok || !thereLabels.ok) return;
    expect(thereLabels.value.map((l) => [l.name, l.color]).sort()).toEqual(
      hereLabels.value.map((l) => [l.name, l.color]).sort(),
    );

    // And the one thing that must differ: what you may do here.
    expect(here.capabilities.write).toBe(true);
    expect(there.capabilities.write).toBe(false);
    // Eight rounds of git reads against HTTP reads: milliseconds when idle,
    // past bun's 5 s default on a loaded check machine (#7686). The verdict
    // is the answers', not the clock's.
  }, 60_000);

  test("a local source refuses a repo the viewer cannot read", () => {
    app.db
      .query("UPDATE repo SET visibility = 'private' WHERE name = 'widgets'")
      .run();
    expect(sourceFor(app, bob, { owner: "alice", name: "widgets" })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(
      sourceFor(app, undefined, { owner: "alice", name: "widgets" }),
    ).toEqual({ ok: false, error: "not_found" });
    expect(sourceFor(app, alice, { owner: "alice", name: "widgets" }).ok).toBe(
      true,
    );
    app.db
      .query("UPDATE repo SET visibility = 'public' WHERE name = 'widgets'")
      .run();
  });

  // ---- the API over it ----

  test("the browse routes answer with the local shapes", async () => {
    const landing = await read<{
      source: string;
      fullName: string;
      mirroredAs: { owner: string; name: string } | null;
      capabilities: { write: boolean };
      facts: { defaultBranch: string };
      branches: { name: string }[];
      readme: { path: string; markdown: string } | null;
    }>(await api(`/api/v1/user/origins/${originId}/browse/octo/widgets`));
    expect(landing.source).toBe("origin");
    expect(landing.fullName).toBe("octo/widgets");
    expect(landing.mirroredAs).toEqual({ owner: "alice", name: "widgets" });
    expect(landing.capabilities.write).toBe(false);
    expect(landing.facts.defaultBranch).toBe("main");
    expect(landing.branches.map((b) => b.name)).toEqual(["main"]);
    expect(landing.readme?.path).toBe("README.md");

    const tree = await read<{ type: string; entries: { name: string }[] }>(
      await api(
        `/api/v1/user/origins/${originId}/browse/octo/widgets/tree/main`,
      ),
    );
    expect(tree.type).toBe("dir");
    expect(tree.entries.map((e) => e.name)).toEqual(["src", "README.md"]);

    const nested = await read<{ path: string; entries: { name: string }[] }>(
      await api(
        `/api/v1/user/origins/${originId}/browse/octo/widgets/tree/main/src`,
      ),
    );
    expect(nested.path).toBe("src");
    expect(nested.entries.map((e) => e.name)).toEqual(["index.ts"]);

    // Byte for byte the shape the local contents endpoint returns.
    const blob = await read<{
      type: string;
      encoding: string;
      content: string;
    }>(
      await api(
        `/api/v1/user/origins/${originId}/browse/octo/widgets/blob/main/README.md`,
      ),
    );
    expect(blob).toMatchObject({ type: "file", encoding: "utf-8" });
    expect(blob.content).toBe(README);

    const commits = await read<{
      items: { oid: string; subject: string }[];
      next_cursor: string | null;
    }>(
      await api(
        `/api/v1/user/origins/${originId}/browse/octo/widgets/commits?ref=main`,
      ),
    );
    expect(commits.items[0]!.subject).toBe("first");

    const commit = await read<{ oid: string; diff: { files: unknown[] } }>(
      await api(
        `/api/v1/user/origins/${originId}/browse/octo/widgets/commits/${commits.items[0]!.oid ?? ""}`,
      ),
    );
    expect(commit.diff.files).toHaveLength(1);

    const issues = await read<{ items: { number: number }[] }>(
      await api(
        `/api/v1/user/origins/${originId}/browse/octo/widgets/issues?state=all`,
      ),
    );
    expect(issues.items.map((i) => i.number)).toEqual([7]);

    const pulls = await read<{ items: { number: number }[] }>(
      await api(
        `/api/v1/user/origins/${originId}/browse/octo/widgets/pulls?state=all`,
      ),
    );
    expect(pulls.items.map((i) => i.number)).toEqual([9]);

    const detail = await read<{
      number: number;
      body: string;
      comments: { body: string }[];
      pull: unknown;
    }>(
      await api(
        `/api/v1/user/origins/${originId}/browse/octo/widgets/issues/7`,
      ),
    );
    expect(detail).toMatchObject({ number: 7, body: "under load", pull: null });
    expect(detail.comments.map((c) => c.body)).toEqual(["seen it too"]);

    const labels = await read<{ name: string }[]>(
      await api(`/api/v1/user/origins/${originId}/browse/octo/widgets/labels`),
    );
    expect(labels.map((l) => l.name).sort()).toEqual(["bug", "chore"]);
  });

  test("a blob past the cap answers 413, like the local one", async () => {
    const response = await api(
      `/api/v1/user/origins/${originId}/browse/octo/heavy/blob/main/big.bin`,
    );
    expect(response.status).toBe(413);
    expect(await read<{ tooLarge: boolean }>(response)).toMatchObject({
      type: "file",
      tooLarge: true,
    });
  });

  test("browsing needs the account: a repo token is refused, another user is not there", async () => {
    const token = await read<{ token: string }>(
      await api("/api/v1/tokens", {
        method: "POST",
        body: JSON.stringify({ adminConfirm: true,
          username: "alice",
          password: ALICE_PASSWORD,
          name: "rw",
          scope: "rw",
        }),
      }),
    );
    expect(token.token).toBeString();
    const paths = [
      `/api/v1/user/origins/${originId}/browse/octo/widgets`,
      `/api/v1/user/origins/${originId}/browse/octo/widgets/tree/main`,
      `/api/v1/user/origins/${originId}/browse/octo/widgets/issues`,
    ];
    for (const path of paths) {
      // A leaked repo token must not become a way to read somebody's GitHub.
      expect((await api(path, { token: token.token })).status).toBe(403);
      // Another account's origin does not exist.
      expect((await api(path, { as: "bob" })).status).toBe(404);
    }
  });

  test("the picker says which rows are already mirrored", async () => {
    const rows = await read<
      { fullName: string; mirroredAs: { owner: string; name: string } | null }[]
    >(await api(`/api/v1/user/origins/${originId}/repos?refresh=1`));
    const widgets = rows.find((r) => r.fullName === "octo/widgets")!;
    expect(widgets.mirroredAs).toEqual({ owner: "alice", name: "widgets" });
    expect(
      rows.find((r) => r.fullName === "octo/hidden")!.mirroredAs,
    ).toBeNull();
  });

  test("the mirror stream reports stages and closes when the job ends", async () => {
    const started = await api(`/api/v1/user/origins/${originId}/mirror`, {
      method: "POST",
      body: JSON.stringify({ fullName: "octo/hidden" }),
    });
    const job = (await read<{ job: { id: string } }>(started)).job;

    const stream = await api(
      `/api/v1/user/origins/${originId}/mirror/${job.id}/stream`,
    );
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    let body = "";
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break; // the server closed it: the job is over
      body += decoder.decode(value, { stream: true });
      if (body.includes("mirror.done") || body.includes("mirror.failed")) {
        // Keep reading: the stream must end itself, not need us to hang up.
        continue;
      }
    }
    expect(body).toContain("event: mirror.");
    expect(body).toMatch(/event: mirror\.(done|failed)/);

    // And the job is readable afterwards, for a UI that arrived late.
    const polled = await read<{ job: { stage: string } }>(
      await api(`/api/v1/user/origins/${originId}/mirror/${job.id}`),
    );
    expect(["done", "failed"]).toContain(polled.job.stage);

    // Somebody else's job is nobody else's business.
    expect(
      (
        await api(`/api/v1/user/origins/${originId}/mirror/${job.id}`, {
          as: "bob",
        })
      ).status,
    ).toBe(404);
  }, MIRROR_MS);

  test("the process-wide cache is the one the sources use", async () => {
    clearViewCache();
    expect(viewCache.stats().entries).toBe(0);
    await live("octo/widgets").labels();
    expect(viewCache.stats().entries).toBeGreaterThan(0);
  });
});
