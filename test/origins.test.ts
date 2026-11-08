import { everyoneIsAMember } from "./helpers/members.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { commitToBranch, forkRepo } from "../src/actions/repos.ts";
import { recordFetch } from "../src/core/origins.ts";
import { getRepo } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { settled } from "../src/origins/jobs.ts";
import { open, seal } from "../src/kernel/secret.ts";
import { discover } from "../src/origins/discover.ts";
import { redact, safeRemoteUrl } from "../src/origins/credentials.ts";
import { providerFor } from "../src/origins/providers/index.ts";
import { staticCredential } from "../src/origins/types.ts";
import { anchorFromHunk } from "../src/origins/providers/http.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { proveAll } from "./helpers/verified.ts";
import { seedAdmin } from "./helpers/admin.ts";

/**
 * Origins, end to end: a real forge, a fake API that behaves like Forgejo,
 * and a *second* real forge standing in for the git host — so the mirror
 * fetch, the ref diff and the push-through all speak real smart HTTP rather
 * than a stub of it.
 */

const ORIGIN_LOGIN = "octo";
const ORIGIN_TOKEN = "octo-origin-secret-9f2a";
const ALICE_PASSWORD = "alice-login-secret";
const BOB_PASSWORD = "bob-login-secret";

const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

/** `response.json()` is `unknown`; every call site knows what it asked for. */
const read = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

describe("origins: connecting, mirroring, writing through", () => {
  let dataDir: string;
  let originDataDir: string;
  let app: App;
  let servers: Servers;
  let originApp: App;
  let originServers: Servers;
  let fake: FakeForge;
  let base: string;
  let originId = "";

  const api = (
    path: string,
    init?: RequestInit & { as?: "alice" | "bob" | "none"; token?: string },
  ) => {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined)
      headers.set("content-type", "application/json");
    if (init?.token !== undefined)
      headers.set("authorization", `Bearer ${init.token}`);
    else if (init?.as === "bob")
      headers.set("authorization", basic("bob", BOB_PASSWORD));
    else if (init?.as !== "none")
      headers.set("authorization", basic("alice", ALICE_PASSWORD));
    return fetch(`${base}${path}`, { ...init, headers });
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-origins-"));
    originDataDir = await mkdtemp(join(tmpdir(), "forge-upstream-"));

    // The "other forge" whose git server we actually clone from.
    originApp = createApp({ dataDir: originDataDir, port: 0 });
    originServers = await serve(originApp);
    await seedAdmin(originApp, {
      username: ORIGIN_LOGIN,
      email: "octo@upstream.test",
      password: ORIGIN_TOKEN,
    });
    await fetch(`${originServers.url}/api/v1/repos`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basic(ORIGIN_LOGIN, ORIGIN_TOKEN),
      },
      body: JSON.stringify({ name: "widgets", visibility: "public" }),
    });
    await fetch(`${originServers.url}/api/v1/repos/octo/widgets/contents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basic(ORIGIN_LOGIN, ORIGIN_TOKEN),
      },
      body: JSON.stringify({
        branch: "main",
        message: "first",
        files: [{ path: "README.md", content: "# widgets\nhello\n" }],
      }),
    });

    // The fake Forgejo API, describing that repo.
    const state = newFakeState("forgejo", ORIGIN_LOGIN, ORIGIN_TOKEN);
    state.repos.push({
      id: 41,
      fullName: "octo/widgets",
      description: "gears and things",
      cloneUrl: `${originServers.url}/octo/widgets.git`,
      htmlUrl: `${originServers.url}/octo/widgets`,
      defaultBranch: "main",
    });
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
    fake = serveFakeForge(state);

    // The forge under test.
    app = createApp({ dataDir, port: 0 });
    everyoneIsAMember(app.db);
    servers = await serve(app);
    base = servers.url;
    await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: ALICE_PASSWORD });
    await fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bob", email: "bob@forge.test", password: BOB_PASSWORD }),
    });
    proveAll(app);
  });

  afterAll(async () => {
    fake.stop();
    servers.stop();
    originServers.stop();
    app.close();
    originApp.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(originDataDir, { recursive: true, force: true });
  });

  // ---- the credential store ----

  test("a sealed token is unreadable, and bound to its own row", () => {
    const sealed = seal(dataDir, "s3cret-token", "origin-a");
    expect(sealed).toStartWith("v1:");
    expect(sealed).not.toContain("s3cret-token");
    expect(open(dataDir, sealed, "origin-a")).toEqual({
      ok: true,
      value: "s3cret-token",
    });
    // Lifted into another row it stops decrypting — a SQL write alone cannot
    // move one account's credential onto another's origin.
    expect(open(dataDir, sealed, "origin-b")).toEqual({
      ok: false,
      error: "bad_key",
    });
    // A tampered ciphertext is a failure, never a garbled plaintext.
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith("A") ? "B" : "A"}`;
    expect(open(dataDir, tampered, "origin-a").ok).toBe(false);
  });

  test("git never sees a credential in argv or a URL", async () => {
    const provider = providerFor(
      staticCredential({
        kind: "forgejo",
        apiUrl: fake.apiUrl,
        webUrl: fake.url,
        login: ORIGIN_LOGIN,
        token: ORIGIN_TOKEN,
      }),
    );
    const remote = "https://git.example/octo/widgets.git";
    const env = await provider.gitAuthEnv(remote);
    // The secret rides in the environment, scoped to one host, with
    // redirects off — never on the command line, never in a config file.
    expect(env.GIT_CONFIG_COUNT).toBe("3");
    // Scoped to the host git will actually contact, not to the web root.
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://git.example/.extraHeader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `Authorization: ${basic(ORIGIN_LOGIN, ORIGIN_TOKEN)}`,
    );
    expect(env.GIT_CONFIG_KEY_1).toBe("http.followRedirects");
    expect(env.GIT_CONFIG_VALUE_1).toBe("false");
    expect(env.GIT_CONFIG_KEY_2).toBe("credential.helper");
    expect(env.GIT_CONFIG_VALUE_2).toBe("");
    // Nothing in the env is the bare token: it is only ever base64 inside a
    // header, which is what keeps a `ps` listing useless.
    expect(Object.values(env).join(" ")).not.toContain(ORIGIN_TOKEN);

    // A URL carrying credentials is refused outright.
    expect(safeRemoteUrl("https://user:pw@example.com/a.git")).toBeUndefined();
    expect(safeRemoteUrl("ext::sh -c whoami")).toBeUndefined();
    expect(safeRemoteUrl("--upload-pack=touch /tmp/x")).toBeUndefined();
    expect(safeRemoteUrl("https://example.com/a.git")).toBe(
      "https://example.com/a.git",
    );
    // And anything that does leak into stderr is scrubbed before it travels.
    expect(
      redact(`fatal: https://x:${ORIGIN_TOKEN}@h/r.git denied`, ORIGIN_TOKEN),
    ).not.toContain(ORIGIN_TOKEN);
  });

  // ---- discovery ----

  test("discovery identifies a forge by its version string", async () => {
    const found = await discover(fake.url);
    expect(found).toEqual({
      ok: true,
      value: {
        kind: "forgejo",
        apiUrl: `${fake.url}/api/v1`,
        webUrl: fake.url,
        via: "version-endpoint",
        software: "16.0.1+gitea-1.22.0",
      },
    });
    // github.com is known by name; nothing is probed.
    const gh = await discover("github");
    expect(gh.ok && gh.value.apiUrl).toBe("https://api.github.com");
    // A host that answers nothing is unreachable, not "some forge".
    const dead = await discover("http://localhost:1/");
    expect(dead).toEqual({ ok: false, error: "unreachable" });
    expect(await discover("not a host")).toEqual({
      ok: false,
      error: "unknown_host",
    });
  });

  // ---- connecting ----

  test("connecting stores a sealed token and takes the login from the origin", async () => {
    const response = await api("/api/v1/user/origins", {
      method: "POST",
      body: JSON.stringify({ host: fake.url, token: ORIGIN_TOKEN }),
    });
    expect(response.status).toBe(201);
    const origin = (await response.json()) as Record<string, unknown>;
    originId = String(origin.id);

    // whoami fixed the login; the caller never said it.
    expect(origin.login).toBe(ORIGIN_LOGIN);
    expect(origin.kind).toBe("forgejo");
    expect(origin.authKind).toBe("pat");
    // No credential field exists at all — the shape cannot leak one.
    expect(Object.keys(origin)).not.toContain("token");
    expect(JSON.stringify(origin)).not.toContain(ORIGIN_TOKEN);

    // Nor is the plaintext anywhere in the database file.
    const stored = app.db
      .query<
        { token_enc: string },
        [string]
      >("SELECT token_enc FROM origin WHERE id = ?1")
      .get(originId);
    expect(stored?.token_enc).toBeString();
    expect(stored!.token_enc).not.toContain(ORIGIN_TOKEN);
    const dbBytes = await readFile(join(dataDir, "forge.db"));
    expect(dbBytes.includes(Buffer.from(ORIGIN_TOKEN))).toBe(false);
  });

  test("a bad token is refused before anything is stored", async () => {
    const response = await api("/api/v1/user/origins", {
      method: "POST",
      body: JSON.stringify({ host: fake.url, token: "not-the-token" }),
    });
    expect(response.status).toBe(422);
    expect((await read<{ error: string }>(response)).error).toBe("bad_token");
  });

  test("listing origins never returns a credential", async () => {
    const listed = (await (
      await api("/api/v1/user/origins")
    ).json()) as unknown[];
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(ORIGIN_TOKEN);
  });

  test("an rw token cannot touch origins; the account itself can", async () => {
    const minted = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true,
        username: "alice",
        password: ALICE_PASSWORD,
        name: "rw",
        scope: "rw",
      }),
    });
    const token = String(((await minted.json()) as { token: string }).token);

    // A leaked rw token must not be able to enumerate or spend someone's
    // GitHub access — origin routes are account-level, not repo-level.
    expect((await api("/api/v1/user/origins", { token })).status).toBe(403);
    expect(
      (
        await api("/api/v1/user/origins", {
          method: "POST",
          token,
          body: JSON.stringify({ host: fake.url, token: ORIGIN_TOKEN }),
        })
      ).status,
    ).toBe(403);
    expect(
      (await api(`/api/v1/user/origins/${originId}/repos`, { token })).status,
    ).toBe(403);
  });

  test("another user's origin does not exist", async () => {
    expect(
      (await api(`/api/v1/user/origins/${originId}/repos`, { as: "bob" }))
        .status,
    ).toBe(404);
    expect(
      (
        await api(`/api/v1/user/origins/${originId}/mirror`, {
          method: "POST",
          as: "bob",
          body: JSON.stringify({ fullName: "octo/widgets" }),
        })
      ).status,
    ).toBe(404);
    const bobsOrigins = (await (
      await api("/api/v1/user/origins", { as: "bob" })
    ).json()) as unknown[];
    expect(bobsOrigins).toHaveLength(0);
  });

  // ---- the picker ----

  test("the picker lists the origin's repositories", async () => {
    const rows = (await (
      await api(`/api/v1/user/origins/${originId}/repos?refresh=1`)
    ).json()) as { fullName: string; mirroredAs: string | null }[];
    expect(rows.map((r) => r.fullName)).toEqual(["octo/widgets"]);
    expect(rows[0]!.mirroredAs).toBeNull();
  });

  // ---- mirroring ----

  test("mirroring creates the repo, fetches git, and imports the units", async () => {
    const response = await api(`/api/v1/user/origins/${originId}/mirror`, {
      method: "POST",
      body: JSON.stringify({ fullName: "octo/widgets" }),
    });
    // 202: the repository does not exist yet, and what comes back is the job
    // to watch. The stages themselves are covered in view-source.test.ts.
    expect(response.status).toBe(202);
    const started = await read<{ job: { id: string; stage: string } }>(
      response,
    );
    expect(started.job.stage).toBe("creating");
    const finished = await settled(started.job.id);
    expect(finished?.stage).toBe("done");

    const repo = (await (await api("/api/v1/repos/alice/widgets")).json()) as {
      name: string;
      visibility: string;
      origin: { kind: string; fullName: string; fetchError: string } | null;
      pinned: boolean;
    };
    expect(repo.name).toBe("widgets");
    // Visibility follows the origin's, never widens.
    expect(repo.visibility).toBe("public");
    expect(repo.origin).toMatchObject({
      kind: "forgejo",
      fullName: "octo/widgets",
      fetchError: "",
    });
    expect(repo.pinned).toBe(false);

    // The git objects really arrived.
    const branches = (
      (await (await api("/api/v1/repos/alice/widgets/branches")).json()) as {
        items: { name: string }[];
      }
    ).items;
    expect(branches.map((b) => b.name)).toEqual(["main"]);
    const readme = (await (
      await api("/api/v1/repos/alice/widgets/contents/README.md")
    ).json()) as { content: string };
    expect(readme.content).toContain("# widgets");

    // Labels, issues and pulls carry the origin's numbers and its authors.
    const labels = (await (
      await api("/api/v1/repos/alice/widgets/labels")
    ).json()) as { items: { name: string }[] };
    expect(labels.items.map((l) => l.name).sort()).toEqual(["bug", "chore"]);

    const issues = (await (
      await api("/api/v1/repos/alice/widgets/issues?state=all")
    ).json()) as { items: Record<string, unknown>[] };
    expect(issues.items).toHaveLength(1);
    const issue = issues.items[0]!;
    expect(issue.number).toBe(7);
    // The local author is the connecting user (so joins keep working) while
    // the real author travels beside it.
    expect(issue.authorName).toBe("alice");
    expect(issue.originAuthor).toBe("mona");
    expect(issue.originUrl).toBeString();
    expect((issue.labels as { name: string }[]).map((l) => l.name)).toEqual([
      "bug",
    ]);

    const detail = (await (
      await api("/api/v1/repos/alice/widgets/issues/7")
    ).json()) as { comments: { body: string; originAuthor: string }[] };
    expect(detail.comments).toHaveLength(1);
    expect(detail.comments[0]).toMatchObject({
      body: "seen it too",
      originAuthor: "mona",
    });

    const pulls = (await (
      await api("/api/v1/repos/alice/widgets/pulls?state=all")
    ).json()) as { items: { number: number; originAuthor: string }[] };
    expect(pulls.items.map((p) => p.number)).toEqual([9]);
    expect(pulls.items[0]!.originAuthor).toBe("hubot");
  });

  test("a first import announces itself once, not once per row", () => {
    const kinds = app.db
      .query<{ kind: string; payload: string }, []>(
        "SELECT kind, payload FROM event ORDER BY id",
      )
      .all()
      .map((e) => e.kind);
    expect(kinds).toContain("repo.mirrored");
    expect(kinds.filter((k) => k === "repo.imported")).toHaveLength(1);
    // The event storm the first import would otherwise be.
    expect(kinds).not.toContain("issue.opened");
  });

  test("mirroring the same repo twice is refused", async () => {
    const again = await api(`/api/v1/user/origins/${originId}/mirror`, {
      method: "POST",
      body: JSON.stringify({ fullName: "octo/widgets" }),
    });
    // The job starts; the refusal arrives on it, because by the time we know
    // it is a repeat we are already inside the mirror.
    expect(again.status).toBe(202);
    const job = await settled(
      (await read<{ job: { id: string } }>(again)).job.id,
    );
    expect(job?.stage).toBe("failed");
    expect(job?.error).toContain("already mirrored");
  });

  // ---- write-through ----

  test("a comment on a mirror is posted upstream first", async () => {
    const before = fake.state.comments.get("octo/widgets")!.length;
    const response = await api(
      "/api/v1/repos/alice/widgets/issues/7/comments",
      { method: "POST", body: JSON.stringify({ body: "on it" }) },
    );
    expect(response.status).toBe(201);
    const comment = (await response.json()) as {
      body: string;
      originAuthor: string;
    };
    // What comes back is the ORIGIN's copy: its body, its author, its id.
    expect(comment.body).toBe("on it");
    expect(comment.originAuthor).toBe(ORIGIN_LOGIN);
    expect(fake.state.comments.get("octo/widgets")!.length).toBe(before + 1);

    const stored = app.db
      .query<
        { n: number },
        []
      >("SELECT COUNT(*) AS n FROM comment WHERE origin_remote_id IS NOT NULL")
      .get()!;
    expect(stored.n).toBe(2);
  });

  test("closing and labelling a mirrored issue go to the origin", async () => {
    const closed = await api("/api/v1/repos/alice/widgets/issues/7", {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
    expect(closed.status).toBe(200);
    expect((await read<{ state: string }>(closed)).state).toBe("closed");
    expect(
      fake.state.issues.get("octo/widgets")!.find((i) => i.number === 7)!.state,
    ).toBe("closed");

    const labelled = await api("/api/v1/repos/alice/widgets/issues/7/labels", {
      method: "PUT",
      body: JSON.stringify({ labels: ["chore"] }),
    });
    expect(labelled.status).toBe(200);
    expect(
      (await read<{ name: string }[]>(labelled)).map((l) => l.name),
    ).toEqual(["chore"]);
    expect(
      fake.state.issues.get("octo/widgets")!.find((i) => i.number === 7)!
        .labels,
    ).toEqual(["chore"]);
  });

  test("an origin that refuses a write changes nothing locally", async () => {
    fake.state.refuseWrite = "issues are locked on this repository";
    const response = await api(
      "/api/v1/repos/alice/widgets/issues/7/comments",
      { method: "POST", body: JSON.stringify({ body: "should not land" }) },
    );
    fake.state.refuseWrite = "";
    expect(response.status).toBe(409);
    expect((await read<{ error: string }>(response)).error).toBe(
      "origin_refused",
    );
    const leaked = app.db
      .query<
        { n: number },
        []
      >("SELECT COUNT(*) AS n FROM comment WHERE body = 'should not land'")
      .get()!;
    expect(leaked.n).toBe(0);
  });

  test("opening a pull on a mirror creates it upstream", async () => {
    const response = await api("/api/v1/repos/alice/widgets/pulls", {
      method: "POST",
      body: JSON.stringify({
        title: "Loosen the bolt",
        body: "the other way",
        base: "main",
        head: "loosen",
      }),
    });
    expect(response.status).toBe(201);
    const pull = (await response.json()) as { number: number; kind: string };
    expect(pull.kind).toBe("pull");
    const upstream = fake.state.issues
      .get("octo/widgets")!
      .find((i) => i.number === pull.number);
    expect(upstream?.title).toBe("Loosen the bolt");
    expect(upstream?.pull?.head).toBe("loosen");
  });

  test("a mirror's fetch error is drawn in the danger notice, not .error-note", async () => {
    const mirror = getRepo(app.db, "alice", "widgets")!;
    recordFetch(app.db, mirror.id, {
      at: "2026-01-01T00:00:00.000Z",
      error: "fetch failed <b>badly</b>",
    });
    try {
      const text = await (await api("/alice/widgets")).text();
      expect(text).toContain(
        '<div class="toast" data-tone="danger" role="status">',
      );
      expect(text).toContain("fetch failed &lt;b&gt;badly&lt;/b&gt;");
      expect(text).not.toContain("error-note");
    } finally {
      recordFetch(app.db, mirror.id, { at: "2026-01-01T00:00:00.000Z" });
    }
  });

  test("a fork proposing its main upstream travels under its owner's name, never onto the origin's main", async () => {
    const alice = getUserByName(app.db, "alice")!;
    const mirror = getRepo(app.db, "alice", "widgets")!;
    const forked = await forkRepo(app, alice, mirror, "widgets-fork");
    if (!forked.ok) throw new Error(String(forked.error));
    const fork = forked.value;
    const committed = await commitToBranch(app, alice, fork, {
      message: "Oil the gear",
      files: [{ path: "OIL.md", content: "a drop\n" }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const branchesOf = async (): Promise<Map<string, string>> => {
      const listed = (
        (await (
          await fetch(`${originServers.url}/api/v1/repos/octo/widgets/branches`)
        ).json()) as { items: { name: string; oid: string }[] }
      ).items;
      return new Map(listed.map((b) => [b.name, b.oid]));
    };
    const before = await branchesOf();

    const response = await api(
      "/api/v1/repos/alice/widgets-fork/following/propose",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const proposed = (await response.json()) as {
      number: number;
      opened: boolean;
    };
    expect(proposed.opened).toBe(true);
    const upstream = fake.state.issues
      .get("octo/widgets")!
      .find((i) => i.number === proposed.number);
    expect(upstream?.pull?.base).toBe("main");
    expect(upstream?.pull?.head).toBe("alice/main");

    // The origin holds the proposal as alice/main; its own main did not move.
    const after = await branchesOf();
    expect(after.get("alice/main")).toBe(committed.value.commitOid);
    expect(after.get("main")).toBe(before.get("main"));
  });

  test("merging a mirrored pull is refused, with a reason", async () => {
    const response = await api("/api/v1/repos/alice/widgets/pulls/9/merge", {
      method: "POST",
      body: JSON.stringify({ strategy: "merge" }),
    });
    expect(response.status).toBe(409);
    const failure = (await response.json()) as {
      error: string;
      message: string;
    };
    expect(failure.error).toBe("mirrored");
    expect(failure.message).toContain("mirrors an origin");
  });

  test("only the person who connected the origin may write through it", async () => {
    const response = await api(
      "/api/v1/repos/alice/widgets/issues/7/comments",
      {
        method: "POST",
        as: "bob",
        body: JSON.stringify({ body: "hello from bob" }),
      },
    );
    expect(response.status).toBe(403);
    expect((await read<{ error: string }>(response)).error).toBe(
      "origin_owner_only",
    );
    // Nothing reached the origin under alice's identity.
    expect(
      fake.state.comments
        .get("octo/widgets")!
        .some((c) => c.body === "hello from bob"),
    ).toBe(false);
  });

  test("a native repo is untouched by any of this", async () => {
    await api("/api/v1/repos", {
      method: "POST",
      body: JSON.stringify({ name: "native", visibility: "public" }),
    });
    const created = await api("/api/v1/repos/alice/native/issues", {
      method: "POST",
      body: JSON.stringify({ title: "local only" }),
    });
    expect(created.status).toBe(201);
    const issue = (await created.json()) as {
      number: number;
      originAuthor: string | null;
    };
    expect(issue.number).toBe(1);
    expect(issue.originAuthor).toBeNull();
    const comment = await api("/api/v1/repos/alice/native/issues/1/comments", {
      method: "POST",
      body: JSON.stringify({ body: "still works" }),
    });
    expect(comment.status).toBe(201);
    expect(
      (await read<{ originAuthor: string | null }>(comment)).originAuthor,
    ).toBeNull();
  });

  // ---- pins ----

  test("pins round-trip and show on the repo", async () => {
    expect(
      (await api("/api/v1/user/pins/alice/widgets", { method: "PUT" })).status,
    ).toBe(200);
    const { items: pins, next_cursor } = (await (
      await api("/api/v1/user/pins")
    ).json()) as {
      items: { owner: string; name: string; cloneUrl: string }[];
      next_cursor: string | null;
    };
    expect(next_cursor).toBeNull();
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ owner: "alice", name: "widgets" });
    expect(pins[0]!.cloneUrl.endsWith("/alice/widgets.git")).toBe(true);
    expect(
      (
        await read<{ pinned: boolean }>(
          await api("/api/v1/repos/alice/widgets"),
        )
      ).pinned,
    ).toBe(true);

    // A pin is one viewer's choice, never a property of the repo.
    expect(
      (
        await read<{ pinned: boolean }>(
          await api("/api/v1/repos/alice/widgets", { as: "bob" }),
        )
      ).pinned,
    ).toBe(false);

    expect(
      (await api("/api/v1/user/pins/alice/widgets", { method: "DELETE" }))
        .status,
    ).toBe(204);
    expect(
      ((await (await api("/api/v1/user/pins")).json()) as { items: unknown[] })
        .items.length,
    ).toBe(0);
  });

  // ---- disconnecting ----

  test("disconnecting keeps the repo readable and stops the syncing", async () => {
    const gone = await api(`/api/v1/user/origins/${originId}`, {
      method: "DELETE",
    });
    expect(gone.status).toBe(200);

    const repo = (await (await api("/api/v1/repos/alice/widgets")).json()) as {
      name: string;
      origin: unknown;
    };
    expect(repo.name).toBe("widgets");
    // The link is gone; everything it pointed at is still here, and the
    // mirror says it is frozen rather than passing for a native repo.
    expect(repo.origin).toMatchObject({
      originId: null,
      fullName: "octo/widgets",
      detached: true,
    });
    const row = app.db
      .query<
        { origin_id: string | null; origin_full_name: string | null },
        []
      >("SELECT origin_id, origin_full_name FROM repo WHERE name = 'widgets'")
      .get()!;
    expect(row.origin_id).toBeNull();
    expect(row.origin_full_name).toBe("octo/widgets");
    const issues = (await (
      await api("/api/v1/repos/alice/widgets/issues?state=all")
    ).json()) as { items: unknown[] };
    expect(issues.items).toHaveLength(1);

    // And the credential is gone with it.
    expect(
      app.db.query("SELECT 1 FROM origin WHERE id = ?1").get(originId),
    ).toBeNull();
    const files = await readdir(dataDir);
    for (const name of files.filter((f) => f.endsWith(".db"))) {
      const bytes = await readFile(join(dataDir, name));
      expect(bytes.includes(Buffer.from(ORIGIN_TOKEN))).toBe(false);
    }

    // A repo whose origin is gone takes local writes again — it is an
    // ordinary repo now, and refusing them would strand it.
    const comment = await api("/api/v1/repos/alice/widgets/issues/7/comments", {
      method: "POST",
      body: JSON.stringify({ body: "after disconnect" }),
    });
    expect(comment.status).toBe(201);
  });
});

describe("review anchors imported from a diff hunk", () => {
  test("the last row of the hunk is the anchor", () => {
    // Both forges truncate diff_hunk at the commented line, so reading it
    // back out is exact — and it is the ONLY signal Forgejo gives.
    expect(
      anchorFromHunk("@@ -3,4 +3,5 @@\n context\n+added\n context2"),
    ).toEqual({ line: 5, side: "new" });
    expect(anchorFromHunk("@@ -10,3 +10,2 @@\n keep\n-gone")).toEqual({
      line: 11,
      side: "old",
    });
    expect(anchorFromHunk("no hunk here")).toEqual({ line: 0, side: "new" });
  });
});

/**
 * The browse reads, in GitHub's dialect. `view-source.test.ts` exercises the
 * whole feature against a Forgejo origin; this is the other adapter, driven
 * directly, because the two forges disagree about almost every one of these
 * endpoints — a readme endpoint that exists on one and not the other, a diff
 * behind a media type rather than a `.diff` suffix, `commit.sha` versus
 * `commit.id` — and an adapter that reads the wrong field returns something
 * plausible and empty rather than an error.
 */
describe("browsing a GitHub origin", () => {
  let fake: FakeForge;
  let provider: ReturnType<typeof providerFor>;

  beforeAll(() => {
    const state = newFakeState("github", "octo", "gh-token-secret-1234");
    state.repos.push({
      id: 7,
      fullName: "octo/tools",
      description: "sharp ones",
      cloneUrl: "https://example.invalid/octo/tools.git",
      defaultBranch: "trunk",
    });
    state.files.set(
      "octo/tools",
      new Map([
        ["README.md", "# tools\n"],
        ["src/main.ts", "export const x = 1;\n"],
        ["src/deep/inner.ts", "export const y = 2;\n"],
      ]),
    );
    state.branches.set("octo/tools", [
      { name: "trunk", sha: "a".repeat(40), protected: true },
      { name: "topic", sha: "b".repeat(40) },
    ]);
    state.tags.set("octo/tools", [{ name: "v2", sha: "a".repeat(40) }]);
    state.commits.set("octo/tools", [
      {
        sha: "a".repeat(40),
        message: "sharpen\n\nand polish",
        authorName: "Mona",
        login: "mona",
        date: "2026-02-02T00:00:00.000Z",
        parents: ["c".repeat(40)],
        diff: [
          "diff --git a/README.md b/README.md",
          "--- a/README.md",
          "+++ b/README.md",
          "@@ -1 +1 @@",
          "-# old",
          "+# tools",
          "",
        ].join("\n"),
      },
    ]);
    state.issues.set("octo/tools", [
      {
        id: 3,
        number: 3,
        title: "a pull",
        user: "mona",
        pull: { base: "trunk", head: "topic", headRepo: "octo/tools" },
      },
    ]);
    state.pullDiffs.set(
      "octo/tools#3",
      [
        "diff --git a/src/main.ts b/src/main.ts",
        "--- a/src/main.ts",
        "+++ b/src/main.ts",
        "@@ -1 +1 @@",
        "-export const x = 1;",
        "+export const x = 2;",
        "",
      ].join("\n"),
    );
    fake = serveFakeForge(state);
    provider = providerFor(
      staticCredential({
        kind: "github",
        apiUrl: fake.apiUrl,
        webUrl: fake.url,
        token: "gh-token-secret-1234",
      }),
    );
  });

  afterAll(() => fake.stop());

  test("branches and tags come back with their object ids", async () => {
    const branches = await provider.listBranches("octo/tools");
    expect(branches.ok && branches.value).toEqual([
      { name: "trunk", oid: "a".repeat(40), protected: true },
      { name: "topic", oid: "b".repeat(40), protected: false },
    ]);
    const tags = await provider.listTags("octo/tools");
    expect(tags.ok && tags.value.map((t) => t.name)).toEqual(["v2"]);
  });

  test("a tree is one level, directories first, with paths from the root", async () => {
    const root = await provider.listTree("octo/tools", "trunk", "");
    expect(root.ok && root.value.map((e) => [e.name, e.kind])).toEqual([
      ["src", "tree"],
      ["README.md", "blob"],
    ]);
    const nested = await provider.listTree("octo/tools", "trunk", "src");
    expect(nested.ok && nested.value.map((e) => e.path)).toEqual([
      "src/deep",
      "src/main.ts",
    ]);
    // A file is not a directory, and the answer says so rather than
    // returning its single row as a listing.
    const file = await provider.listTree("octo/tools", "trunk", "README.md");
    expect(file.ok).toBe(false);
  });

  test("a blob arrives as bytes; a readme knows its own path", async () => {
    const blob = await provider.getBlob("octo/tools", "trunk", "README.md");
    expect(blob.ok).toBe(true);
    if (!blob.ok) return;
    expect(new TextDecoder().decode(blob.value.content)).toBe("# tools\n");
    expect(blob.value.truncated).toBe(false);
    expect(blob.value.size).toBe(8);

    const readme = await provider.getReadme("octo/tools", "trunk");
    expect(readme.ok && readme.value?.path).toBe("README.md");
  });

  test("a path that climbs out of the repository is never requested", async () => {
    const before = fake.state.requests.length;
    for (const path of ["../etc/passwd", "a/../../b", "/etc/passwd", "a/"]) {
      expect((await provider.getBlob("octo/tools", "trunk", path)).ok).toBe(
        false,
      );
      expect((await provider.listTree("octo/tools", "trunk", path)).ok).toBe(
        false,
      );
    }
    // A ref that git would read as a flag, or that carries a range, likewise.
    for (const ref of ["-oops", "a..b", "with space"]) {
      expect((await provider.listTree("octo/tools", ref, "")).ok).toBe(false);
      expect((await provider.listCommits("octo/tools", ref)).ok).toBe(false);
    }
    expect(fake.state.requests.length).toBe(before);
  });

  test("commits carry the login beside the name, and their parents", async () => {
    const page = await provider.listCommits("octo/tools", "trunk");
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    const commit = page.value.items[0]!;
    expect(commit.oid).toBe("a".repeat(40));
    expect(commit.message).toBe("sharpen\n\nand polish");
    expect(commit.author.name).toBe("Mona");
    expect(commit.author.login).toBe("mona");
    expect(commit.parents).toEqual(["c".repeat(40)]);
  });

  test("a diff comes back parsed — from the media type, not a suffix", async () => {
    const commit = await provider.getCommitDiff("octo/tools", "a".repeat(40));
    expect(commit.ok && commit.value.files.map((f) => f.path)).toEqual([
      "README.md",
    ]);
    const pull = await provider.getPullDiff("octo/tools", 3);
    expect(pull.ok && pull.value.files.map((f) => f.path)).toEqual([
      "src/main.ts",
    ]);
    expect(pull.ok && pull.value.additions).toBe(1);
    // The request that fetched it asked for the diff media type, which is
    // the only thing that makes GitHub answer with one.
    const asked = fake.state.requests.filter((r) =>
      r.path.endsWith("/pulls/3"),
    );
    expect(asked.length).toBeGreaterThan(0);
  });

  test("a missing thing is not_found, and a missing readme is simply null", async () => {
    expect(
      (await provider.getBlob("octo/tools", "trunk", "nope.txt")).ok,
    ).toBe(false);
    const readme = await provider.getReadme("octo/nothing", "trunk");
    expect(readme.ok && readme.value).toBeNull();
  });
});
