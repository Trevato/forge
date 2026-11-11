import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { forkRepo } from "../src/actions/repos.ts";
import { eventAudience } from "../src/core/event_audience.ts";
import { listEvents } from "../src/core/events.ts";
import { createOrigin, getOriginById } from "../src/core/origins.ts";
import { syncOrigin, syncsSettled } from "../src/origins/sync.ts";
import { getRepo } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { readFeed } from "../src/feed/feed.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  mirrorAndWait,
  newFakeState,
  serveFakeForge,
  type FakeForge,
} from "./fake-origin.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { proveAll } from "./helpers/verified.ts";
import { seedAdmin } from "./helpers/admin.ts";

/**
 * A detached mirror, reconnected (#1090). What happened live: an origin's
 * token died, the origin was deleted and connected again, and its mirror
 * was left frozen — `origin_id` gone, provenance kept — while the fork
 * following it read "ahead 813, behind 0" against an upstream that had
 * moved. Here the same story runs end to end on a real forge, a fake
 * Forgejo API and a second real forge as the git host: the frozen mirror
 * says so everywhere its state is shown, refuses pushes still, and comes
 * back by connecting again or by one click, with its refs moving at once.
 */

// Every test here clones, syncs or waits on a background sync; on a loaded
// check machine the 5 s default decides nothing about the code under test.
setDefaultTimeout(60_000);

const ORIGIN_LOGIN = "octo";
const ORIGIN_TOKEN = "octo-origin-secret-5c1e";
const MONA_TOKEN = "mona-origin-secret-77ad";
const ALICE_PASSWORD = "alice-login-secret";
const BOB_PASSWORD = "bob-login-secret";

const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

const read = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

/** A page's text with its whitespace folded, so a sentence reads as one. */
const words = async (response: Response): Promise<string> =>
  (await response.text()).replace(/\s+/g, " ");

const clientEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "Alice",
  GIT_AUTHOR_EMAIL: "alice@forge.test",
  GIT_COMMITTER_NAME: "Alice",
  GIT_COMMITTER_EMAIL: "alice@forge.test",
});

async function git(
  args: string[],
  cwd: string,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: clientEnv,
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

interface RepoJson {
  name: string;
  origin: {
    originId: string | null;
    fullName: string;
    host: string;
    detached: boolean;
    frozenSince: string | null;
    detachedAt: string | null;
  } | null;
}

interface Reattached {
  owner: string;
  name: string;
  fullName: string;
  refused: string | null;
}

describe("a frozen mirror is said, and reconnected in one click", () => {
  let dataDir: string;
  let originDataDir: string;
  let workDir: string;
  let app: App;
  let servers: Servers;
  let originApp: App;
  let originServers: Servers;
  /** The account the mirror was made through. */
  let octo: FakeForge;
  /** Another account on the same host — one that cannot see the repo, at first. */
  let mona: FakeForge;
  let base: string;
  let originId = "";
  let monaOriginId = "";

  const api = (
    path: string,
    init?: RequestInit & { as?: "alice" | "bob" | "none" },
  ) => {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    if (init?.as === "bob")
      headers.set("authorization", basic("bob", BOB_PASSWORD));
    else if (init?.as !== "none")
      headers.set("authorization", basic("alice", ALICE_PASSWORD));
    return fetch(`${base}${path}`, { redirect: "manual", ...init, headers });
  };

  const repoJson = async (name = "widgets"): Promise<RepoJson> =>
    read<RepoJson>(await api(`/api/v1/repos/alice/${name}`));

  const mirrorMain = (): Promise<string | undefined> =>
    resolveOid(repoDir(app.reposRoot, "alice", "widgets"), "refs/heads/main");
  const upstreamMain = (): Promise<string | undefined> =>
    resolveOid(
      repoDir(originApp.reposRoot, ORIGIN_LOGIN, "widgets"),
      "refs/heads/main",
    );

  /** The sync after a reconnect runs in the background; wait for its refs. */
  async function mirrorReaches(oid: string): Promise<void> {
    await refReaches(() => mirrorMain(), oid);
  }

  /**
   * Wait for a ref to reach an oid. No deadline of its own: the sync that
   * moves it is awaited, and the test's timeout is the only bound, so a
   * loaded machine slows it and never fails it.
   */
  async function refReaches(
    read: () => Promise<string | undefined>,
    oid: string,
  ): Promise<void> {
    while ((await read()) !== oid) {
      await Promise.race([syncsSettled(), Bun.sleep(50)]);
    }
  }

  /** Commit straight onto the upstream's main, as someone working there. */
  async function advanceUpstream(path: string): Promise<string> {
    const made = await fetch(
      `${originServers.url}/api/v1/repos/octo/widgets/contents`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basic(ORIGIN_LOGIN, ORIGIN_TOKEN),
        },
        body: JSON.stringify({
          branch: "main",
          message: `upstream: ${path}`,
          files: [{ path, content: `${path}\n` }],
        }),
      },
    );
    expect(made.status).toBeLessThan(300);
    return (await upstreamMain())!;
  }

  const connect = (fake: FakeForge, token: string) =>
    api("/api/v1/user/origins", {
      method: "POST",
      body: JSON.stringify({ host: fake.url, token }),
    });

  const reconnect = (
    id: string,
    as: "alice" | "bob" | "none" = "alice",
    repo = "widgets",
  ) =>
    api(`/api/v1/repos/alice/${repo}/origin/reconnect`, {
      method: "POST",
      body: JSON.stringify({ originId: id }),
      as,
    });

  const disconnect = async (id: string): Promise<void> => {
    const gone = await api(`/api/v1/user/origins/${id}`, { method: "DELETE" });
    expect(gone.status).toBe(200);
  };

  /** An origin row for alice, made the way a connect makes one. */
  const originRow = (fake: FakeForge, webUrl: string): string => {
    const alice = getUserByName(app.db, "alice")!;
    const made = createOrigin(app.db, app.config.dataDir, {
      userId: alice.id,
      kind: "forgejo",
      apiUrl: `${webUrl}/api/v1`,
      webUrl,
      login: fake.state.login,
      token: fake.state.token,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value.id;
  };

  const widgetsRepo = {
    id: 41,
    fullName: "octo/widgets",
    description: "gears and things",
    defaultBranch: "main",
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-reconnect-"));
    originDataDir = await mkdtemp(join(tmpdir(), "forge-reconnect-up-"));
    workDir = await mkdtemp(join(tmpdir(), "forge-reconnect-work-"));

    // The other forge, whose git we clone from.
    originApp = createApp({ dataDir: originDataDir, port: 0 });
    originServers = await serve(originApp);
    await seedAdmin(originApp, {
      username: ORIGIN_LOGIN,
      email: "octo@upstream.test",
      password: ORIGIN_TOKEN,
    });
    proveAll(originApp);
    await fetch(`${originServers.url}/api/v1/repos`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basic(ORIGIN_LOGIN, ORIGIN_TOKEN),
      },
      body: JSON.stringify({ name: "widgets", visibility: "public" }),
    });
    await advanceUpstream("README.md");

    const octoState = newFakeState("forgejo", ORIGIN_LOGIN, ORIGIN_TOKEN);
    octoState.repos.push({
      ...widgetsRepo,
      cloneUrl: `${originServers.url}/octo/widgets.git`,
      htmlUrl: `${originServers.url}/octo/widgets`,
    });
    octo = serveFakeForge(octoState);
    // The repository's page lives on the origin's own site, as it does on a
    // real Forgejo; only the git clone comes from the forge standing in for
    // its git host. A reconnect compares sites, scheme and port included.
    octoState.repos[0]!.htmlUrl = `${octo.url}/octo/widgets`;
    mona = serveFakeForge(newFakeState("forgejo", "mona", MONA_TOKEN));

    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: ALICE_PASSWORD });
    await fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bob", email: "bob@forge.test", password: BOB_PASSWORD }),
    });
    proveAll(app);

    // Connect, mirror octo/widgets as alice/widgets, and fork the mirror so
    // there is a following card to read.
    const connected = await connect(octo, ORIGIN_TOKEN);
    expect(connected.status).toBe(201);
    originId = (await read<{ id: string }>(connected)).id;
    const job = await mirrorAndWait(
      await api(`/api/v1/user/origins/${originId}/mirror`, {
        method: "POST",
        body: JSON.stringify({ fullName: "octo/widgets" }),
      }),
    );
    expect(job?.stage).toBe("done");
    const forked = await forkRepo(
      app,
      getUserByName(app.db, "alice"),
      getRepo(app.db, "alice", "widgets")!,
      "widgets-fork",
    );
    if (!forked.ok) throw new Error(String(forked.error));
    await api("/api/v1/repos", {
      method: "POST",
      body: JSON.stringify({ name: "plain", visibility: "public" }),
    });
  }, 120_000);

  afterAll(async () => {
    // A sync started by a reconnect may outlive the test that waited for its
    // refs; it must not write into a directory being removed.
    await syncsSettled();
    octo.stop();
    mona.stop();
    servers.stop();
    originServers.stop();
    app.close();
    originApp.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
    await rm(originDataDir, { recursive: true, force: true, maxRetries: 5 });
    await rm(workDir, { recursive: true, force: true, maxRetries: 5 });
  }, 120_000);

  test("an attached mirror says where it comes from, and is not frozen", async () => {
    const repo = await repoJson();
    expect(repo.origin).toMatchObject({
      originId,
      fullName: "octo/widgets",
      detached: false,
      frozenSince: null,
    });
    const home = await words(await api("/alice/widgets"));
    expect(home).not.toContain('id="frozen"');
    const fork = await words(await api("/alice/widgets-fork"));
    expect(fork).toContain("Everything here is up to date with alice/widgets");
  });

  test("a dead credential counts its frozen mirrors; connecting again renews it in place", async () => {
    app.db
      .query(
        "UPDATE origin SET needs_reauth = 1, last_error = 'expired' WHERE id = ?1",
      )
      .run(originId);
    const page = await words(await api("/settings/origins"));
    expect(page).toContain("One mirror is frozen until it is re-authorized.");
    expect(page).toContain("Re-authorize octo at");
    const alice = getUserByName(app.db, "alice")!;
    const feed = readFeed(app.db, alice, { limit: 50 }).items;
    expect(feed.find((i) => i.id === `reauth:${originId}`)?.what).toContain(
      "needs re-authorizing; 1 mirror is frozen",
    );

    // The same account again: a new credential on the same row, so the
    // mirror never detached and nothing has to be re-attached.
    const renewed = await connect(octo, ORIGIN_TOKEN);
    expect(renewed.status).toBe(201);
    const body = await read<{
      id: string;
      needsReauth: boolean;
      reattached: Reattached[];
    }>(renewed);
    expect(body.id).toBe(originId);
    expect(body.needsReauth).toBe(false);
    expect(body.reattached).toEqual([]);
    expect((await repoJson()).origin?.detached).toBe(false);
    expect(
      readFeed(app.db, alice, { limit: 50 }).items.some((i) =>
        i.id.startsWith("reauth:"),
      ),
    ).toBe(false);
    // The renewed origin's sync is under way; let it finish before the
    // next test disconnects the origin out from under it.
    await syncOrigin(app, getOriginById(app.db, originId)!);
  });

  test("disconnecting the origin freezes the mirror, and every page says so", async () => {
    await disconnect(originId);

    const repo = await repoJson();
    expect(repo.origin).toMatchObject({
      originId: null,
      fullName: "octo/widgets",
      detached: true,
    });
    expect(repo.origin?.host).toStartWith("localhost:");
    expect(repo.origin?.frozenSince).toBeString();
    // The database recorded when, through the foreign key's own SET NULL.
    expect(repo.origin?.detachedAt).toBeString();

    const day = repo.origin!.detachedAt!.slice(0, 10);
    for (const path of ["/alice/widgets", "/alice/widgets/branches"]) {
      const page = await words(await api(path));
      expect(page).toContain('id="frozen"');
      expect(page).not.toMatch(/class="[^"]*\bfrozen(-form|-sentence)?\b/);
      expect(page).toContain("octo/widgets");
      expect(page).toContain(
        `but that origin was disconnected on <time datetime="`,
      );
      expect(page).toContain(`>${day}</time>`);
      expect(page).toContain("it has been frozen since");
      // Alice has no origin on that host now: the way back is connecting one.
      expect(page).toContain("Settings → Connected accounts");
      expect(page).toContain("connecting one reconnects this mirror by itself");
    }
    // A reader who cannot administer it reads the sentence, not the form.
    const bobs = await words(await api("/alice/widgets", { as: "bob" }));
    expect(bobs).toContain("it has been frozen since");
    expect(bobs).toContain("An admin of this repository can reconnect it.");
    expect(bobs).not.toContain("/settings/origin/reconnect");

    // The account's own settings list it under what came from where.
    const settings = await words(await api("/settings/origins"));
    expect(settings).toContain("Frozen mirrors");
    expect(settings).toContain("alice/widgets");

    // And the feed asks its owner to reconnect it.
    const alice = getUserByName(app.db, "alice")!;
    const mirrorId = getRepo(app.db, "alice", "widgets")!.id;
    expect(
      readFeed(app.db, alice, { limit: 50 }).items.find(
        (i) => i.id === `frozen:${mirrorId}`,
      )?.what,
    ).toBe("alice/widgets is frozen; reconnect its origin");
  });

  test("a fork following a frozen mirror never says it is up to date", async () => {
    const page = await words(await api("/alice/widgets-fork"));
    expect(page).toContain(
      "alice/widgets is frozen: its origin was disconnected on",
    );
    expect(page).toContain("so what is here may be behind.");
    expect(page).toContain('href="/alice/widgets#frozen"');
    expect(page).toContain("parent frozen");
    expect(page).not.toContain("up to date");
    expect(page).not.toContain("in step");

    const following = await read<{
      parentFrozen: { detachedAt: string } | null;
    }>(await api("/api/v1/repos/alice/widgets-fork/following"));
    expect(following.parentFrozen?.detachedAt).toBeString();

    // Taking updates with nothing to take says what it knows, and no more.
    const took = await api("/api/v1/repos/alice/widgets-fork/sync", {
      method: "POST",
    });
    expect(took.status).toBe(200);
    const flash = await api("/alice/widgets-fork/following", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: "do=take",
    });
    const said = await read<{ flash?: string }>(flash);
    expect(said.flash).toContain("which is frozen");
    expect(said.flash).not.toContain("up to date");
  });

  test("a push to a frozen mirror is still refused", async () => {
    const clone = join(workDir, "widgets");
    const url = new URL(`${base}/alice/widgets.git`);
    url.username = "alice";
    url.password = ALICE_PASSWORD;
    expect(
      (await git(["clone", "-q", url.toString(), clone], workDir)).code,
    ).toBe(0);
    await Bun.write(join(clone, "local.txt"), "local\n");
    await git(["add", "."], clone);
    await git(["commit", "-qm", "local"], clone);
    const before = await mirrorMain();
    const pushed = await git(["push", "-q", "origin", "main"], clone);
    expect(pushed.code).not.toBe(0);
    expect(pushed.err).toContain("reconnect the origin before pushing");
    expect(await mirrorMain()).toBe(before);
  });

  test("another port is another site: not offered, not reattached, refused by hand", async () => {
    // mona's forge shares the hostname and differs only by port.
    const connected = await connect(mona, MONA_TOKEN);
    expect(connected.status).toBe(201);
    const body = await read<{ id: string; reattached: Reattached[] }>(
      connected,
    );
    monaOriginId = body.id;
    expect(body.reattached).toEqual([]);
    expect((await repoJson()).origin?.detached).toBe(true);
    // The page still says frozen, but offers nothing to reconnect with:
    // mona's origin is another site, so it is not in the list.
    const page = await words(await api("/alice/widgets"));
    expect(page).toContain("frozen");
    expect(page).not.toContain(`value="${monaOriginId}"`);
    const refused = await reconnect(monaOriginId);
    expect(refused.status).toBe(422);
    expect((await read<{ error: string }>(refused)).error).toBe("wrong_host");
  });

  test("on the right site: an account that cannot see the repository is refused, and a mirror with no remembered id is never guessed", async () => {
    // The account can no longer see octo/widgets.
    const held = octo.state.repos.splice(0, octo.state.repos.length);
    const connected = await connect(octo, ORIGIN_TOKEN);
    expect(connected.status).toBe(201);
    const body = await read<{ id: string; reattached: Reattached[] }>(
      connected,
    );
    expect(body.reattached).toEqual([
      {
        owner: "alice",
        name: "widgets",
        fullName: "octo/widgets",
        refused: "origin_cannot_see",
      },
    ]);
    expect((await repoJson()).origin?.detached).toBe(true);
    await syncsSettled();
    octo.state.repos.push(...held);
    // A mirror from before remote ids were kept is not guessed at: the same
    // name could be a repository made again.
    const repoId = getRepo(app.db, "alice", "widgets")!.id;
    const prior = app.db
      .query<{ origin_remote_id: string }, [string]>(
        "SELECT origin_remote_id FROM repo WHERE id = ?1",
      )
      .get(repoId)!.origin_remote_id;
    expect(prior).not.toBe("");
    app.db
      .query("UPDATE repo SET origin_remote_id = '' WHERE id = ?1")
      .run(repoId);
    const guessed = await reconnect(body.id);
    expect(guessed.status).toBe(422);
    expect((await read<{ error: string }>(guessed)).error).toBe(
      "remote_unknown",
    );
    app.db
      .query("UPDATE repo SET origin_remote_id = ?1 WHERE id = ?2")
      .run(prior, repoId);
    // Leave things as the next test expects: the mirror frozen, this origin gone.
    await disconnect(body.id);
    expect((await repoJson()).origin?.detached).toBe(true);
  });

  test("an origin on another host is refused", async () => {
    // The same fake, reached by another name: another host as far as any
    // check that reads a hostname is concerned.
    const elsewhere = originRow(
      mona,
      mona.url.replace("localhost", "127.0.0.1"),
    );
    const refused = await reconnect(elsewhere);
    expect(refused.status).toBe(422);
    expect((await read<{ error: string }>(refused)).error).toBe("wrong_host");
    expect((await repoJson()).origin?.detached).toBe(true);
  });

  test("only an admin of the repo reconnects it, through an origin of their own", async () => {
    // Bob reads the public mirror but administers nothing of it.
    expect((await reconnect(monaOriginId, "bob")).status).toBe(404);
    expect((await reconnect(monaOriginId, "none")).status).toBe(401);
    const form = await api("/alice/widgets/settings/origin/reconnect", {
      method: "POST",
      as: "bob",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `origin=${monaOriginId}`,
    });
    expect(form.status).toBe(404);
    const anonymous = await api("/alice/widgets/settings/origin/reconnect", {
      method: "POST",
      as: "none",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `origin=${monaOriginId}`,
    });
    expect(anonymous.status).toBe(404);
    // Someone else's origin is not one alice can name.
    const bob = getUserByName(app.db, "bob")!;
    const bobs = createOrigin(app.db, app.config.dataDir, {
      userId: bob.id,
      kind: "forgejo",
      apiUrl: octo.apiUrl,
      webUrl: octo.url,
      login: ORIGIN_LOGIN,
      token: ORIGIN_TOKEN,
    });
    if (!bobs.ok) throw new Error(bobs.error);
    expect((await reconnect(bobs.value.id)).status).toBe(404);
    expect((await repoJson()).origin?.detached).toBe(true);
    app.db.query("DELETE FROM origin WHERE id = ?1").run(bobs.value.id);
  });

  test("a repo that is not a frozen mirror is not_detached", async () => {
    const refused = await reconnect(monaOriginId, "alice", "plain");
    expect(refused.status).toBe(422);
    expect((await read<{ error: string }>(refused)).error).toBe("not_detached");
  });

  test("connecting the origin again re-attaches the mirror and moves its refs", async () => {
    const tip = await advanceUpstream("moved.txt");
    expect(await mirrorMain()).not.toBe(tip);

    const connected = await connect(octo, ORIGIN_TOKEN);
    expect(connected.status).toBe(201);
    const body = await read<{ id: string; reattached: Reattached[] }>(
      connected,
    );
    originId = body.id;
    expect(body.reattached).toEqual([
      {
        owner: "alice",
        name: "widgets",
        fullName: "octo/widgets",
        refused: null,
      },
    ]);
    await mirrorReaches(tip);
    await syncsSettled();

    const repo = await repoJson();
    expect(repo.origin).toMatchObject({
      originId,
      detached: false,
      frozenSince: null,
      detachedAt: null,
    });
    expect(await words(await api("/alice/widgets"))).not.toContain(
      'id="frozen"',
    );
    const fork = await words(await api("/alice/widgets-fork"));
    expect(fork).not.toContain("is frozen");

    // Recorded for the repo's admins, and in words.
    const mirrorId = getRepo(app.db, "alice", "widgets")!.id;
    const event = listEvents(app.db, { repoId: mirrorId }).find(
      (e) => e.kind === "origin.mirror_reattached",
    );
    expect(event?.payload).toEqual({
      origin: originId,
      fullName: "octo/widgets",
    });
    expect(eventAudience("origin.mirror_reattached")).toBe("admins");
  });

  test("reconnecting by hand, through the API and through the page", async () => {
    // Another connection of alice's on the same site — the way a person
    // reconnects after making a fresh token for the same forge.
    await disconnect(originId);
    let tip = await advanceUpstream("api.txt");
    const byApi = originRow(octo, octo.url);
    const viaApi = await reconnect(byApi);
    expect(viaApi.status).toBe(200);
    const json = await read<RepoJson>(viaApi);
    expect(json.origin).toMatchObject({
      originId: byApi,
      detached: false,
    });
    await mirrorReaches(tip);
    await syncsSettled();

    await disconnect(byApi);
    expect((await repoJson()).origin?.detached).toBe(true);
    const again = originRow(octo, octo.url);
    tip = await advanceUpstream("page.txt");
    const offered = await api("/alice/widgets").then((r) => r.text());
    expect(offered).toContain("it has been frozen since");
    expect(offered).toContain(
      'action="/alice/widgets/settings/origin/reconnect"',
    );
    expect(offered).toContain('name="origin"');
    expect(offered).toContain(`value="${again}"`);
    expect(offered).toContain("Reconnect through");
    expect(await words(await api("/alice/widgets"))).toContain("Reconnect");
    for (const old of ["frozen-form", "frozen-sentence", 'class="card frozen'])
      expect(offered).not.toContain(old);
    const viaPage = await api("/alice/widgets/settings/origin/reconnect", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `origin=${again}`,
    });
    expect(viaPage.status).toBe(303);
    expect(
      decodeURIComponent(viaPage.headers.get("set-cookie") ?? ""),
    ).toContain(`Reconnected to ${octo.state.login} at ${new URL(octo.url).host}; syncing.`);
    await mirrorReaches(tip);
    await syncsSettled();
    expect((await repoJson()).origin).toMatchObject({
      originId: again,
      detached: false,
    });

    // And the fork, which has nothing of its own, follows its parent again.
    const forkDir = repoDir(app.reposRoot, "alice", "widgets-fork");
    await refReaches(() => resolveOid(forkDir, "refs/heads/main"), tip);
    await syncOrigin(app, getOriginById(app.db, again)!);
  });
});
