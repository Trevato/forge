/**
 * The operator guard on the account behind an origin (`origins/operator.ts`,
 * `origins/credential.ts`).
 *
 * A forge keeps an origin's credential where its agents run, so the risk is
 * the account a person authorized. On a host the operator guards, an
 * account that administers the instance is refused, and so is one that can
 * push to a repository `FORGE_ORIGIN_DENY_PUSH` protects: on a pasted token,
 * on an OAuth consent, after each refresh, and on the daily sweep of what is
 * already stored. A check that cannot finish pauses writes (reads go on)
 * until it can, and refuses the origin after a day.
 *
 * The adversarial cases carry the weight: a walk that moves, a count that
 * lies, a lookup that fails beside a hit, a refresh that races a refusal.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  checkOriginAgain,
  connectOrigin,
  replaceOriginToken,
  startMirrorJob,
  startOAuthConnect,
  syncOriginNow,
} from "../src/actions/origins.ts";
import { contribute, forkOrigin } from "../src/actions/contribute.ts";
import { openIssueThrough } from "../src/actions/issues.ts";
import { originPush } from "../src/actions/branches.ts";
import { carryBranchThrough, pushThrough } from "../src/origins/push-through.ts";
import {
  getCursor,
  listOriginRepos,
  listOrigins,
  markNeedsReauth,
  setCursor,
  storeRefreshed,
} from "../src/core/origins.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { settled } from "../src/origins/jobs.ts";
import {
  denyPushRules,
  guarded,
  GUARD_MAX_PAGES,
  operatorHosts,
} from "../src/origins/operator.ts";
import {
  providerForOrigin,
  recheckOrigin,
  runGuardSweep,
  writesPaused,
} from "../src/origins/credential.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { promote } from "./helpers/members.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { fastFirstFetch, quietLogs, withoutEnv } from "./helpers/globals.ts";
import {
  newFakeOAuth,
  newFakeState,
  serveFakeForge,
  type FakeForge,
  type FakeState,
} from "./fake-origin.ts";

quietLogs();
fastFirstFetch();

const ENV = ["FORGE_ORIGIN_CLIENT_ID", "FORGE_ORIGIN_DENY_PUSH", "FORGE_URL"] as const;
withoutEnv(...ENV);

const LOGIN = "octo";
const TOKEN = "octo-guard-secret-7c1e";
const PASSWORD = "a-long-guard-passphrase";
const CLIENT_ID = "forge-guard-client";

const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

/** Run `fn` with these variables set, and put back what was there. */
async function withEnv<T>(
  vars: Partial<Record<(typeof ENV)[number], string>>,
  fn: () => Promise<T>,
): Promise<T> {
  const before = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    before.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// ---- the parsing, with no forge at all ----

describe("the operator's variables", () => {
  test("operator hosts are FORGE_ORIGIN_CLIENT_ID's, by hostname", () => {
    expect(
      operatorHosts({
        FORGE_ORIGIN_CLIENT_ID: " Git.Example=abc , other.example=d,broken,=x,empty=",
      }),
    ).toEqual(["git.example", "other.example"]);
    expect(operatorHosts({})).toEqual([]);
  });

  test("deny-push rules: bare for every host, host: for one, owner alone is owner/*", () => {
    const rules = denyPushRules({
      FORGE_ORIGIN_DENY_PUSH:
        "system/*, git.example:platform/*, Infra, a/b/c, bad name/x, acme/app-*,git.example:8443:ops/deploy",
    });
    expect(rules.map((r) => [r.host, r.pattern, r.exact])).toEqual([
      [null, "system/*", false],
      ["git.example", "platform/*", false],
      [null, "infra/*", false],
      [null, "acme/app-*", false],
      ["git.example", "ops/deploy", true],
    ]);
    const [system, , infra, apps] = rules;
    expect(system!.matches("System/Open-Platform")).toBe(true);
    expect(system!.matches("systems/x")).toBe(false);
    expect(infra!.matches("infra/anything")).toBe(true);
    expect(apps!.matches("acme/app-jobs")).toBe(true);
    expect(apps!.matches("acme/jobs")).toBe(false);
  });

  test("a host is guarded when the operator registered it or a rule covers it", () => {
    const at = { apiUrl: "https://git.example/api/v1", webUrl: "https://git.example" };
    expect(guarded(at, {})).toBe(false);
    expect(guarded(at, { FORGE_ORIGIN_CLIENT_ID: "git.example=id" })).toBe(true);
    expect(guarded(at, { FORGE_ORIGIN_DENY_PUSH: "other.example:system/*" })).toBe(false);
    expect(guarded(at, { FORGE_ORIGIN_DENY_PUSH: "system/*" })).toBe(true);
  });
});

// ---- against a fake Forgejo and a real forge serving its git ----

describe("the guard against an operator's Forgejo", () => {
  let upstreamDir: string;
  let upstreamApp: App;
  let upstream: Servers;
  let fake: FakeForge;
  let state: FakeState;

  /** A forge of our own, with one member, and its session cookie. */
  interface Local {
    dir: string;
    app: App;
    servers: Servers;
    cookie: string;
    alice: User;
  }
  const locals: Local[] = [];

  /** A member of `app`, made directly (sign-ups are limited per address). */
  const member = async (app: App, username: string): Promise<User> => {
    const made = await createUser(app.db, {
      username,
      email: `${username}@forge.test`,
      password: PASSWORD,
      origin: "seed",
      trusted: true,
    });
    if (!made.ok) throw new Error(`no account ${username}: ${made.error}`);
    // A member, as an owner would make it: a guest owns no repository.
    promote(app.db, made.value);
    return getUserByName(app.db, username)!;
  };
  const boot = async (): Promise<Local> => {
    const dir = await mkdtemp(join(tmpdir(), "forge-guard-"));
    const app = createApp({ dataDir: dir, port: 0 });
    const servers = await serve(app);
    const alice = await member(app, "alice");
    const local = {
      dir,
      app,
      servers,
      cookie: `forge_session=${createSession(app.db, alice.id).token}`,
      alice,
    };
    locals.push(local);
    return local;
  };

  /** A browser request: session cookie, manual redirects, a real Origin. */
  const browse = (
    local: Local,
    path: string,
    form?: Record<string, string>,
    cookie = local.cookie,
  ): Promise<Response> => {
    const headers = new Headers({ cookie });
    if (form !== undefined) headers.set("origin", new URL(local.servers.url).origin);
    return fetch(`${local.servers.url}${path}`, {
      method: form === undefined ? "GET" : "POST",
      headers,
      redirect: "manual",
      ...(form === undefined ? {} : { body: new URLSearchParams(form) }),
    });
  };

  const host = (): string => new URL(fake.url).hostname;

  beforeAll(async () => {
    upstreamDir = await mkdtemp(join(tmpdir(), "forge-guard-up-"));
    upstreamApp = createApp({ dataDir: upstreamDir, port: 0 });
    upstream = await serve(upstreamApp);
    // The git host's own account: seeded, so it may make repositories.
    const seeded = await seedAdmin(upstreamApp, {
      username: LOGIN,
      email: "octo@up.test",
      password: TOKEN,
    });
    if (!seeded.ok) throw new Error(`no git-host account: ${seeded.error}`);
    await fetch(`${upstream.url}/api/v1/repos`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: basic(LOGIN, TOKEN) },
      body: JSON.stringify({ name: "widgets", visibility: "public" }),
    });
    await fetch(`${upstream.url}/api/v1/repos/octo/widgets/contents`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: basic(LOGIN, TOKEN) },
      body: JSON.stringify({
        branch: "main",
        message: "first",
        files: [{ path: "README.md", content: "# widgets\n" }],
      }),
    });

    state = newFakeState("forgejo", LOGIN, TOKEN);
    state.repos.push(
      {
        id: 41,
        fullName: "octo/widgets",
        cloneUrl: `${upstream.url}/octo/widgets.git`,
        htmlUrl: `${upstream.url}/octo/widgets`,
        pushedAt: "2026-10-01T00:00:00Z",
      },
      {
        id: 42,
        fullName: "acme-corp/jobs",
        cloneUrl: `${upstream.url}/octo/widgets.git`,
        pushedAt: "2026-10-02T00:00:00Z",
      },
      {
        id: 43,
        fullName: "system/deploy",
        cloneUrl: `${upstream.url}/octo/widgets.git`,
        push: false,
        admin: false,
      },
    );
    baseline = state.repos.map((r) => ({ ...r }));
    state.oauth = newFakeOAuth(CLIENT_ID);
    fake = serveFakeForge(state);
  });

  afterAll(async () => {
    fake.stop();
    upstream.stop();
    upstreamApp.close();
    for (const local of locals) {
      local.servers.stop();
      local.app.close();
      forgetProviders(local.dir);
      await rm(local.dir, { recursive: true, force: true });
    }
    await rm(upstreamDir, { recursive: true, force: true });
  });

  /** The fake as it starts every test: an ordinary account, nothing protected. */
  let baseline: FakeState["repos"] = [];
  const reset = (): void => {
    state.siteAdmin = false;
    delete state.onRepoPage;
    delete state.repoTotalOverride;
    delete state.failRepos;
    delete state.oauth!.onRefresh;
    state.maxResponseItems = 50;
    state.oauth!.expiresIn = 3600;
    state.repos = baseline.map((r) => ({ ...r }));
  };
  const deploy = () => state.repos.find((r) => r.fullName === "system/deploy")!;
  const operator = () => ({ FORGE_ORIGIN_CLIENT_ID: `${host()}=${CLIENT_ID}` });

  /**
   * Authorize on the instance with the operator's application, and come back
   * to the forge's callback. Run inside `withEnv(operator())`.
   */
  const consent = async (local: Local): Promise<Response> => {
    const started = await startOAuthConnect(local.app, local.alice, {
      host: fake.url,
      redirectUri: `${local.servers.url}/settings/origins/callback`,
    });
    if (!started.ok) throw new Error(`no flow: ${started.error.message}`);
    const at = new URL(started.value.url);
    return browse(
      local,
      `/settings/origins/callback?state=${encodeURIComponent(at.searchParams.get("state")!)}&code=${state.oauth!.authCode}`,
    );
  };

  /** A refusal from the guard, or a thrown test. */
  const guardError = (result: Awaited<ReturnType<typeof connectOrigin>>) => {
    if (result.ok || typeof result.error === "string" || !("repos" in result.error))
      throw new Error("not a guard refusal");
    return result.error;
  };

  // ---- a pasted token ----

  describe("on a pasted token", () => {
    let local: Local;
    let n = 0;
    /** A fresh account per attempt: connecting is rate-limited per person. */
    const person = (): Promise<User> => member(local.app, `p${++n}`);
    const paste = (who: User) =>
      connectOrigin(local.app, who, { host: fake.url, token: TOKEN });

    beforeAll(async () => {
      local = await boot();
    });

    test("an administrator's token is refused on the operator's host, and nothing is stored", async () => {
      reset();
      state.siteAdmin = true;
      const who = await person();
      const refused = await withEnv(operator(), () => paste(who));
      reset();
      const error = guardError(refused);
      expect(error.error).toBe("admin_account");
      expect(error.message).toContain("everyday non-admin account");
      expect(listOrigins(local.app.db, who.id)).toHaveLength(0);
    });

    test("the same token connects where the operator guards nothing, as before", async () => {
      reset();
      state.siteAdmin = true;
      const connected = await paste(await person());
      reset();
      expect(connected.ok).toBe(true);
    });

    test("replacing a stored token meets the same guard, and a refusal keeps the old token", async () => {
      reset();
      const who = await person();
      const connected = await paste(who);
      if (!connected.ok) throw new Error("no origin to replace the token of");
      const swap = (token: string) =>
        replaceOriginToken(local.app, who, connected.value.id, token);

      state.siteAdmin = true;
      const refused = await withEnv(operator(), () => swap(TOKEN));
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error).toBe("admin_account");

      // Where the operator guards nothing, the same token is replaced as before.
      expect((await swap(TOKEN)).ok).toBe(true);

      state.siteAdmin = false;
      const passed = await withEnv(operator(), () => swap(TOKEN));
      reset();
      expect(passed.ok).toBe(true);
    });

    test("a token that can push to a protected repository is refused, naming it", async () => {
      reset();
      deploy().push = true;
      const who = await person();
      const refused = await withEnv({ FORGE_ORIGIN_DENY_PUSH: "system/*" }, () => paste(who));
      reset();
      const error = guardError(refused);
      expect(error.error).toBe("can_push");
      expect(error.repos).toEqual(["system/deploy"]);
      expect(error.message).toContain("system/deploy");
      expect(listOrigins(local.app.db, who.id)).toHaveLength(0);
    });

    test("a repository named outright is asked about by name", async () => {
      reset();
      deploy().push = true;
      const who = await person();
      const before = state.requests.length;
      const refused = await withEnv({ FORGE_ORIGIN_DENY_PUSH: "system/deploy" }, () =>
        paste(who),
      );
      const asked = state.requests.slice(before).map((r) => r.path);
      reset();
      expect(guardError(refused).repos).toEqual(["system/deploy"]);
      expect(asked).toContain("/api/v1/repos/system/deploy");
    });

    test("an account that cannot push there connects, and its repositories are cached at once", async () => {
      reset();
      const connected = await withEnv({ FORGE_ORIGIN_DENY_PUSH: "system/*" }, async () =>
        paste(await person()),
      );
      if (!connected.ok) throw new Error("connect failed");
      const cached = listOriginRepos(local.app.db, connected.value.id).map((r) => r.fullName);
      expect(cached.sort()).toEqual(["acme-corp/jobs", "octo/widgets", "system/deploy"]);
      // It passed, so its writes are not paused.
      await withEnv({ FORGE_ORIGIN_DENY_PUSH: "system/*" }, async () => {
        expect(writesPaused(local.app, connected.value.id)).toBeUndefined();
      });
    });

    test("an account with more repositories than the guard reads is refused, not waved through", async () => {
      reset();
      // A page of one, and more repositories than the walk has pages.
      state.maxResponseItems = 1;
      for (let i = 0; i < GUARD_MAX_PAGES; i++)
        state.repos.push({ id: 500 + i, fullName: `octo/extra-${i}`, cloneUrl: "", push: false });
      const who = await person();
      const refused = await withEnv({ FORGE_ORIGIN_DENY_PUSH: "system/*" }, () => paste(who));
      reset();
      expect(guardError(refused).error).toBe("guard_unchecked");
      expect(listOrigins(local.app.db, who.id)).toHaveLength(0);
    });

    test("a protected repository pushed mid-walk cannot slip past: the walk is by id, with no fallback", async () => {
      reset();
      state.maxResponseItems = 1;
      deploy().push = true;
      deploy().pushedAt = "2020-01-01T00:00:00Z";
      // Between pages, the protected repository becomes the most recently
      // updated: in a newest-first listing it would jump to the page already read.
      state.onRepoPage = (page) => {
        if (page === 2) deploy().pushedAt = new Date().toISOString();
      };
      const before = state.requests.length;
      const refused = await withEnv({ FORGE_ORIGIN_DENY_PUSH: "system/*" }, async () =>
        paste(await person()),
      );
      const requests = state.requests.slice(before);
      const walked = requests.filter((r) => r.path.endsWith("/repos/search"));
      reset();
      expect(guardError(refused).repos).toEqual(["system/deploy"]);
      expect(walked.length).toBeGreaterThanOrEqual(3);
      for (const r of walked) expect(r.query).toContain("sort=id");
      expect(requests.some((r) => r.path.endsWith("/user/repos"))).toBe(false);
    });

    test("a count that does not add up refuses: one the origin overstates, and one that changes mid-walk", async () => {
      reset();
      state.repoTotalOverride = 4;
      const overstated = await withEnv({ FORGE_ORIGIN_DENY_PUSH: "system/*" }, async () =>
        paste(await person()),
      );
      reset();
      expect(guardError(overstated).error).toBe("guard_unchecked");

      state.maxResponseItems = 1;
      state.onRepoPage = (page) => {
        if (page === 2) state.repos = state.repos.filter((r) => r.fullName !== "octo/widgets");
      };
      const shrunk = await withEnv({ FORGE_ORIGIN_DENY_PUSH: "system/*" }, async () =>
        paste(await person()),
      );
      reset();
      expect(guardError(shrunk).error).toBe("guard_unchecked");
    });

    test("a confirmed hit is refused as one, even when another lookup fails", async () => {
      reset();
      deploy().push = true;
      state.repos.push({ id: 44, fullName: "ops/broken", cloneUrl: "", push: false });
      state.failRepos = new Set(["ops/broken"]);
      const refused = await withEnv(
        { FORGE_ORIGIN_DENY_PUSH: "ops/broken,system/deploy" },
        async () => paste(await person()),
      );
      reset();
      const error = guardError(refused);
      expect(error.error).toBe("can_push");
      expect(error.repos).toEqual(["system/deploy"]);
    });

    test("a hit in a walk that did not finish is refused as one, not as unchecked", async () => {
      reset();
      deploy().push = true;
      state.maxResponseItems = 1;
      // The count says one more than there is: the walk ends incomplete, after
      // it has read the protected repository.
      state.repoTotalOverride = 4;
      const refused = await withEnv({ FORGE_ORIGIN_DENY_PUSH: "system/*" }, async () =>
        paste(await person()),
      );
      reset();
      const error = guardError(refused);
      expect(error.error).toBe("can_push");
      expect(error.repos).toEqual(["system/deploy"]);
    });

    test("every repository named outright is asked about, the sixtieth too", async () => {
      reset();
      deploy().push = true;
      const names = [...Array.from({ length: 59 }, (_, i) => `ops/repo-${i}`), "system/deploy"];
      const before = state.requests.length;
      const refused = await withEnv({ FORGE_ORIGIN_DENY_PUSH: names.join(",") }, async () =>
        paste(await person()),
      );
      const asked = state.requests
        .slice(before)
        .filter((r) => /^\/api\/v1\/repos\/(ops|system)\//.test(r.path));
      reset();
      expect(guardError(refused).repos).toEqual(["system/deploy"]);
      expect(asked).toHaveLength(60);
    });

    test("the web form says the guard's sentence and keeps no token", async () => {
      reset();
      state.siteAdmin = true;
      const who = await person();
      const cookie = `forge_session=${createSession(local.app.db, who.id).token}`;
      const response = await withEnv(operator(), () =>
        browse(local, "/settings/origins/token", { host: fake.url, token: TOKEN }, cookie),
      );
      reset();
      expect(response.status).toBe(422);
      const page = await response.text();
      expect(page).toContain("is an administrator of localhost");
      expect(page).not.toContain(TOKEN);
      expect(listOrigins(local.app.db, who.id)).toHaveLength(0);
    });
  });

  // ---- an OAuth consent ----

  describe("on an OAuth consent", () => {
    test("an administrator who consents is refused with the sentence, and nothing is kept", async () => {
      reset();
      state.siteAdmin = true;
      const local = await boot();
      await withEnv(operator(), async () => {
        const back = await consent(local);
        reset();
        expect(back.status).toBe(303);
        const to = back.headers.get("location")!;
        expect(to).toStartWith("/settings/origins?error=");
        const page = await (await browse(local, to)).text();
        expect(page).toContain("everyday non-admin account");
        expect(page).toContain("did not keep the token");
        // The whole sentence, with where to remove the grant: not cut short.
        expect(page).toContain("under Settings → Applications.");
        expect(listOrigins(local.app.db, local.alice.id)).toHaveLength(0);
      });
    });

    test("an everyday account consents, connects, and writes at once", async () => {
      reset();
      const local = await boot();
      await withEnv(operator(), async () => {
        const back = await consent(local);
        expect(back.headers.get("location")).toBe("/settings/origins?connected=1");
        const origins = listOrigins(local.app.db, local.alice.id);
        expect(origins).toHaveLength(1);
        expect(origins[0]!.authKind).toBe("oauth");
        expect(writesPaused(local.app, origins[0]!.id)).toBeUndefined();
      });
    });
  });

  // ---- what is already stored ----

  describe("stored origins, checked again", () => {
    const deny = () => ({ ...operator(), FORGE_ORIGIN_DENY_PUSH: "system/*" });

    test("a refresh checks the account again and cuts it off before the new token is used", async () => {
      reset();
      // A token that expires inside the refresh margin: the next use refreshes it.
      state.oauth!.expiresIn = 30;
      const local = await boot();
      await withEnv(deny(), async () => {
        await consent(local);
        const origin = listOrigins(local.app.db, local.alice.id)[0]!;
        expect(origin.needsReauth).toBe(false);

        // Since it connected, the account was given push on a protected repository.
        deploy().push = true;
        const provider = providerForOrigin(local.app, origin);
        if (!provider.ok) throw new Error("no provider");
        const used = await provider.value.whoami();
        expect(used.ok).toBe(false);
        expect(state.oauth!.tokenRequests.at(-1)?.grant_type).toBe("refresh_token");

        const after = listOrigins(local.app.db, local.alice.id)[0]!;
        expect(after.needsReauth).toBe(true);
        expect(after.lastError).toContain("system/deploy");
        // Nothing travels on it any more: no git credential either.
        expect(await provider.value.gitAuthEnv(`${upstream.url}/octo/widgets.git`)).toEqual({});
        const page = await (await browse(local, "/settings/origins")).text();
        expect(page).toContain("can push to system/deploy");
        expect(page).toContain(`Re-authorize ${LOGIN} at`);
      });
      reset();
    });

    test("the sweep refuses an origin connected before the guard, and leaves it refused", async () => {
      reset();
      deploy().push = true;
      const local = await boot();
      // Connected with nothing guarded: the forge as it was before the guard.
      const connected = await connectOrigin(local.app, local.alice, { host: fake.url, token: TOKEN });
      if (!connected.ok) throw new Error("connect failed");
      await withEnv(deny(), async () => {
        await runGuardSweep(local.app);
        const after = listOrigins(local.app.db, local.alice.id)[0]!;
        expect(after.needsReauth).toBe(true);
        expect(after.lastError).toContain("system/deploy");
        // A refused origin is not checked again until someone reconnects it.
        const before = state.requests.length;
        await runGuardSweep(local.app);
        expect(state.requests.length).toBe(before);
      });
      reset();
    });

    test("while a connection cannot be verified, every write is paused and reads go on", async () => {
      reset();
      const local = await boot();
      const connected = await withEnv(deny(), () =>
        connectOrigin(local.app, local.alice, { host: fake.url, token: TOKEN }),
      );
      if (!connected.ok) throw new Error("connect failed");
      const id = connected.value.id;
      const job = startMirrorJob(local.app, local.alice, id, "octo/widgets", "widgets");
      if (!job.ok) throw new Error("mirror refused");
      const mirror = (await settled(job.value.id))!.repo!;

      await withEnv(deny(), async () => {
        // The check runs, and cannot finish: a count that does not add up.
        state.repoTotalOverride = 99;
        const checked = await checkOriginAgain(local.app, local.alice, id);
        delete state.repoTotalOverride;
        expect(checked.ok && checked.value).toBe("unchecked");
        expect(writesPaused(local.app, id)).toBeDefined();
        expect(listOrigins(local.app.db, local.alice.id)[0]!.needsReauth).toBe(false);

        const writesBefore = state.requests.filter((r) => r.method !== "GET").length;
        // Write-through, a push, a branch carried up, a fork, a contribution:
        // every one refused here, before the origin is asked.
        const issue = await openIssueThrough(local.app, local.alice, mirror, { title: "x" });
        expect(!issue.ok && issue.error).toBe("origin_paused");
        const push = await originPush(local.app, local.alice, mirror);
        expect(!push.ok && push.error).toBe("origin_paused");
        const carried = await carryBranchThrough(local.app, mirror, mirror, "topic", local.alice.id);
        expect(!carried.ok && carried.error.message).toContain("writes through it are paused");
        const pushed = await pushThrough(local.app, mirror, [], {}, local.alice.id);
        expect(pushed.ok).toBe(false);
        const forked = await forkOrigin(local.app, local.alice, id, "acme-corp/jobs");
        expect(!forked.ok && forked.error).toBe("origin_paused");
        const proposed = await contribute(local.app, local.alice, {
          originId: id,
          fullName: "octo/widgets",
          branch: "topic",
          files: [{ path: "a.txt", content: "a" }],
        });
        expect(!proposed.ok && proposed.error).toBe("origin_paused");
        // And the adapter itself refuses any request that is not a read.
        const provider = providerForOrigin(local.app, listOrigins(local.app.db, local.alice.id)[0]!);
        if (!provider.ok) throw new Error("no provider");
        const direct = await provider.value.createIssue("octo/widgets", { title: "x", body: "" });
        expect(!direct.ok && direct.error.error).toBe("forbidden");
        expect(state.requests.filter((r) => r.method !== "GET").length).toBe(writesBefore);

        // Reads go on.
        expect((await provider.value.whoami()).ok).toBe(true);
        const synced = await syncOriginNow(local.app, local.alice, id);
        expect(synced.ok && synced.value.error).toBe("");

        // Settings → Connected accounts says so, with the way out.
        const page = await (await browse(local, "/settings/origins")).text();
        expect(page).toContain("Couldn't verify this connection; writes paused");
        expect(page).toContain(`action="/settings/origins/${id}/check"`);
        // Asked again at once: too soon, said on the page it was asked from.
        const again = await browse(local, `/settings/origins/${id}/check`, {});
        expect(again.status).toBe(303);
        expect(again.headers.get("location")).toBe("/settings/origins");
        expect(writesPaused(local.app, id)).toBeDefined();

        // A check that passes turns writes back on.
        const passed = await recheckOrigin(
          local.app,
          listOrigins(local.app.db, local.alice.id)[0]!,
          provider.value,
        );
        expect(passed).toBe("passed");
        expect(writesPaused(local.app, id)).toBeUndefined();
        const opened = await openIssueThrough(local.app, local.alice, mirror, { title: "now" });
        expect(opened.ok).toBe(true);
        const after = await (await browse(local, "/settings/origins")).text();
        expect(after).not.toContain("writes paused");

        // One that has not run for a day refuses the origin.
        state.repoTotalOverride = 99;
        setCursor(
          local.app.db,
          id,
          "guard_unchecked_since",
          new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
        );
        expect(
          await recheckOrigin(local.app, listOrigins(local.app.db, local.alice.id)[0]!, provider.value),
        ).toBe("refused");
        delete state.repoTotalOverride;
        expect(listOrigins(local.app.db, local.alice.id)[0]!.needsReauth).toBe(true);
      });
      reset();
    });

    test("Check again on Settings → Connected accounts runs the guard and says what it found", async () => {
      reset();
      const local = await boot();
      // Connected before the guard: never checked, so paused once guarded.
      const connected = await connectOrigin(local.app, local.alice, { host: fake.url, token: TOKEN });
      if (!connected.ok) throw new Error("connect failed");
      const id = connected.value.id;
      await withEnv(deny(), async () => {
        expect(writesPaused(local.app, id)).toBeDefined();
        const checked = await browse(local, `/settings/origins/${id}/check`, {});
        expect(checked.status).toBe(303);
        expect(checked.headers.get("location")).toBe("/settings/origins");
        const flash = (checked.headers.get("set-cookie") ?? "").split(";")[0]!;
        const page = await (
          await browse(local, "/settings/origins", undefined, `${local.cookie}; ${flash}`)
        ).text();
        expect(page).toContain("Verified. Writes through this connection are on again.");
        expect(writesPaused(local.app, id)).toBeUndefined();
        // Another person's origin is not theirs to check.
        const bob = await member(local.app, "bob");
        const theirs = await checkOriginAgain(local.app, bob, id);
        expect(!theirs.ok && theirs.error).toBe("not_found");
      });
      reset();
    });

    test("a refresh that races a refusal never undoes it", async () => {
      reset();
      state.oauth!.expiresIn = 30;
      const local = await boot();
      await withEnv(deny(), async () => {
        await consent(local);
        const origin = listOrigins(local.app.db, local.alice.id)[0]!;
        // The sweep refuses the origin while its refresh is on the wire.
        state.oauth!.onRefresh = () =>
          markNeedsReauth(local.app.db, origin.id, "refused by the sweep");
        const provider = providerForOrigin(local.app, origin);
        if (!provider.ok) throw new Error("no provider");
        const used = await provider.value.whoami();
        expect(state.oauth!.tokenRequests.at(-1)?.grant_type).toBe("refresh_token");
        expect(used.ok).toBe(false);
        const after = listOrigins(local.app.db, local.alice.id)[0]!;
        expect(after.needsReauth).toBe(true);
        expect(after.lastError).toBe("refused by the sweep");
      });
      // And the store itself: a refresh written after a refusal keeps it.
      const origin = listOrigins(local.app.db, local.alice.id)[0]!;
      storeRefreshed(local.app.db, local.dir, origin.id, { token: "t", expiresAt: null });
      expect(listOrigins(local.app.db, local.alice.id)[0]!.needsReauth).toBe(true);
      reset();
    });

    test("the sweep checks one origin at a time, stamps the ones that pass, and then rests", async () => {
      reset();
      const local = await boot();
      const bob = await member(local.app, "bob");
      for (const who of [local.alice, bob]) {
        const made = await connectOrigin(local.app, who, { host: fake.url, token: TOKEN });
        if (!made.ok) throw new Error("connect failed");
      }
      const ids = [local.alice, bob].map((u) => listOrigins(local.app.db, u.id)[0]!.id);
      const stamped = () =>
        ids.filter((id) => getCursor(local.app.db, id, "guard_checked_at") !== undefined).length;
      await withEnv(deny(), async () => {
        expect(stamped()).toBe(0);
        await runGuardSweep(local.app);
        expect(stamped()).toBe(1);
        await runGuardSweep(local.app);
        expect(stamped()).toBe(2);
        const before = state.requests.length;
        await runGuardSweep(local.app);
        expect(state.requests.length).toBe(before);
      });
      expect(listOrigins(local.app.db, bob.id)[0]!.needsReauth).toBe(false);
    });
  });
});
