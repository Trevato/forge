import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { setLimit } from "../src/settings/limits.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { oauthCallbackUri } from "../src/http/api.ts";
import { listEvents } from "../src/core/events.ts";
import { getOriginById, sealedSecrets } from "../src/core/origins.ts";
import { getRepo } from "../src/core/repos.ts";
import { providerForOrigin } from "../src/origins/credential.ts";
import { dueOrigins } from "../src/origins/sync.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { seal } from "../src/kernel/secret.ts";
import {
  mirrorAndWait,
  newFakeOAuth,
  newFakeState,
  s256,
  serveFakeForge,
  type FakeForge,
  type FakeOAuth,
} from "./fake-origin.ts";
import { fastFirstFetch, withoutEnv } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";
import { seedAdmin } from "./helpers/admin.ts";

/**
 * Adversarial review of the origins surface: OAuth (state, PKCE, redirect
 * handling, device polling, refresh, needs_reauth) and authorization (token
 * scopes per route, cross-user isolation, write-through ownership, pins,
 * visibility of mirrored private repos, disconnect, and secret leakage).
 * Every claim here is exercised over the wire against a booted forge.
 */

const LOGIN = "octo";
const ORIGIN_TOKEN = "octo-origin-secret-4b1d";
const PASSWORD = "login-secret-for-tests";
const CLIENT_ID = "Iv1.forge-security-client";
const CLIENT_SECRET = "app-client-secret-do-not-leak-7e3f";
const CALLBACK = "/settings/origins/callback";

const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

const read = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

type Caller = (
  path: string,
  init?: RequestInit & { as?: string; token?: string; none?: boolean },
) => Promise<Response>;

function callerFor(base: string): Caller {
  return (path, init) => {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined)
      headers.set("content-type", "application/json");
    if (init?.token !== undefined)
      headers.set("authorization", `Bearer ${init.token}`);
    else if (!init?.none)
      headers.set("authorization", basic(init?.as ?? "alice", PASSWORD));
    return fetch(`${base}${path}`, { redirect: "manual", ...init, headers });
  };
}

async function createUsers(base: string, names: string[]): Promise<void> {
  for (const username of names) {
    await fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        email: `${username}@forge.test`,
        password: PASSWORD,
      }),
    });
  }
}

async function mintToken(
  base: string,
  username: string,
  scope: "ro" | "rw" | "admin",
): Promise<string> {
  const minted = await read<{ token: string }>(
    await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true,
        username,
        password: PASSWORD,
        name: scope,
        scope,
      }),
    }),
  );
  return minted.token;
}

const originCount = (app: App): number =>
  app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM origin").get()!.n;

// A fetch that fails should say so now, not after the forge's patience.
fastFirstFetch();
// The code flow's redirect_uri is this test server's own, unless a test says
// otherwise — never the forge a crew machine's `FORGE_URL` names.
withoutEnv("FORGE_URL");

// ------------------------------------------------------------- code flow

describe("OAuth code flow: state, PKCE, redirects, and the callback URI", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let fake: FakeForge;
  let oauth: FakeOAuth;
  let base: string;
  let caller: Caller;
  // Each test starts its flows as an account of its own, and a test that
  // starts more than five uses more than one: the connect cap (five per
  // person per window) has its own test, and these are about the flow.
  let who = "alice";
  let accounts = 0;
  const fresh = async (): Promise<string> => {
    const name = `flow${++accounts}`;
    await createUsers(base, [name]);
    proveAll(app);
    // A code flow needs the client registered by the account that starts it.
    await caller("/api/v1/user/origin-apps", {
      method: "POST",
      as: name,
      body: JSON.stringify({ host: fake.url, clientId: CLIENT_ID }),
    });
    return name;
  };
  const api: Caller = (path, init) =>
    caller(path, { ...init, as: init?.as ?? who });

  const start = async (as = who) => {
    const response = await api("/api/v1/user/origins/oauth", {
      method: "POST",
      as,
      body: JSON.stringify({ host: fake.url }),
    });
    expect(response.status).toBe(201);
    const started = await read<{ flowId: string; url: string }>(response);
    const url = new URL(started.url);
    return {
      flowId: started.flowId,
      state: url.searchParams.get("state")!,
      challenge: url.searchParams.get("code_challenge")!,
      redirectUri: url.searchParams.get("redirect_uri")!,
    };
  };
  const callback = (query: string, init?: Parameters<Caller>[1]) =>
    api(`${CALLBACK}?${query}`, init);
  const refreshCount = () =>
    oauth.tokenRequests.filter((r) => r.grant_type === "authorization_code")
      .length;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-sec-code-"));
    const state = newFakeState("forgejo", LOGIN, ORIGIN_TOKEN);
    oauth = newFakeOAuth(CLIENT_ID);
    state.oauth = oauth;
    fake = serveFakeForge(state);
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    setLimit(app.db, "signup.per_source", 1000, "setup");
    base = servers.url;
    caller = callerFor(base);
    await createUsers(base, ["alice", "bob"]);
    proveAll(app);
    forgetProviders(dataDir);
    await api("/api/v1/user/origin-apps", {
      method: "POST",
      as: "alice",
      body: JSON.stringify({ host: fake.url, clientId: CLIENT_ID }),
    });
  });
  beforeEach(async () => {
    who = await fresh();
  });
  afterAll(async () => {
    fake.stop();
    servers.stop();
    app.close();
    forgetProviders(dataDir);
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a state belongs to the user who started it: nobody else can spend it, and it stays valid for its owner", async () => {
    app.db.query("DELETE FROM origin").run();
    const flow = await start();
    const exchanges = refreshCount();

    // Bob, signed in, presents Alice's state with a valid code.
    const stolen = await callback(
      `state=${encodeURIComponent(flow.state)}&code=${oauth.authCode}`,
      { as: "bob" },
    );
    expect(stolen.status).toBe(303);
    expect(stolen.headers.get("location")).toBe(
      "/settings/origins?error=state",
    );
    // An anonymous browser presents it too.
    const anonymous = await callback(
      `state=${encodeURIComponent(flow.state)}&code=${oauth.authCode}`,
      { none: true },
    );
    // Signing in comes first; the state is still checked against whoever comes back.
    expect(anonymous.headers.get("location")).toStartWith("/signin?next=");
    // No exchange happened, no credential landed on anyone, and Alice's flow
    // was not burned by someone else's attempt.
    expect(refreshCount()).toBe(exchanges);
    expect(originCount(app)).toBe(0);
    const row = app.db
      .query<
        { status: string; state_hash: string | null },
        [string]
      >("SELECT status, state_hash FROM oauth_flow WHERE id = ?1")
      .get(flow.flowId)!;
    expect(row.status).toBe("pending");
    expect(row.state_hash).not.toBeNull();

    // The rightful owner completes it once...
    const mine = await callback(
      `state=${encodeURIComponent(flow.state)}&code=${oauth.authCode}`,
    );
    expect(mine.headers.get("location")).toBe("/settings/origins?connected=1");
    expect(originCount(app)).toBe(1);
    expect(
      getOriginById(
        app.db,
        app.db.query<{ id: string }, []>("SELECT id FROM origin").get()!.id,
      )!.userId,
    ).toBe(
      app.db
        .query<
          { id: string },
          [string]
        >("SELECT id FROM user WHERE username = ?1")
        .get(who)!.id,
    );

    // ...and the same state+code is dead on replay: no second exchange.
    const replay = await callback(
      `state=${encodeURIComponent(flow.state)}&code=${oauth.authCode}`,
    );
    expect(replay.headers.get("location")).toBe(
      "/settings/origins?error=state",
    );
    expect(refreshCount()).toBe(exchanges + 1);
    expect(originCount(app)).toBe(1);
  });

  test("an expired state is refused over the wire without an exchange", async () => {
    app.db.query("DELETE FROM origin").run();
    const flow = await start();
    app.db
      .query("UPDATE oauth_flow SET expires_at = ?1 WHERE id = ?2")
      .run(new Date(Date.now() - 1000).toISOString(), flow.flowId);
    const before = refreshCount();
    const response = await callback(
      `state=${encodeURIComponent(flow.state)}&code=${oauth.authCode}`,
    );
    expect(response.headers.get("location")).toBe(
      "/settings/origins?error=state",
    );
    expect(refreshCount()).toBe(before);
    expect(originCount(app)).toBe(0);
  });

  test("a valid code with the wrong PKCE verifier is refused by the provider and lands nothing", async () => {
    app.db.query("DELETE FROM origin").run();
    const flow = await start();
    // The provider now checks the verifier against the challenge it saw.
    oauth.expectedChallenge = flow.challenge;
    // Simulate a forge whose stored verifier is not the preimage.
    app.db
      .query("UPDATE oauth_flow SET verifier_enc = ?1 WHERE id = ?2")
      .run(seal(dataDir, "not-the-real-verifier", flow.flowId), flow.flowId);

    const response = await callback(
      `state=${encodeURIComponent(flow.state)}&code=${oauth.authCode}`,
    );
    const location = response.headers.get("location")!;
    expect(location).toStartWith("/settings/origins?error=");
    expect(decodeURIComponent(location)).toContain("did not finish the sign-in");
    expect(originCount(app)).toBe(0);
    // And the flow is finished, not retriable.
    expect(
      app.db
        .query<
          { status: string },
          [string]
        >("SELECT status FROM oauth_flow WHERE id = ?1")
        .get(flow.flowId)!.status,
    ).toBe("failed");

    // With the real verifier the same strict provider accepts the exchange:
    // the forge really sends S256's preimage and the exact redirect URI.
    const good = await start();
    oauth.expectedChallenge = good.challenge;
    oauth.expectedRedirectUri = `${base}${CALLBACK}`;
    const ok = await callback(
      `state=${encodeURIComponent(good.state)}&code=${oauth.authCode}`,
    );
    expect(ok.headers.get("location")).toBe("/settings/origins?connected=1");
    expect(s256(oauth.tokenRequests.at(-1)!.code_verifier!)).toBe(
      good.challenge,
    );
    delete oauth.expectedChallenge;
    delete oauth.expectedRedirectUri;
  });

  test("a callback carrying error=access_denied burns the state and creates nothing", async () => {
    app.db.query("DELETE FROM origin").run();
    const flow = await start();
    const before = refreshCount();
    const declined = await callback(
      `error=access_denied&error_description=The+user+denied&state=${encodeURIComponent(flow.state)}`,
    );
    expect(declined.status).toBe(303);
    expect(declined.headers.get("location")).toStartWith(
      "/settings/origins?error=",
    );
    expect(declined.headers.get("location")).toStartWith("/settings/origins?error=");
    expect(declined.headers.get("location")).not.toContain("connected=");
    expect(refreshCount()).toBe(before);
    expect(originCount(app)).toBe(0);
    // The state cannot be resurrected with a code afterwards.
    const later = await callback(
      `state=${encodeURIComponent(flow.state)}&code=${oauth.authCode}`,
    );
    expect(later.headers.get("location")).toBe("/settings/origins?error=state");
    expect(refreshCount()).toBe(before);
  });

  test("the callback never redirects anywhere but its own settings page", async () => {
    app.db.query("DELETE FROM origin").run();
    const attempts = [
      "redirect=//evil.com",
      "next=https://evil.com",
      "return_to=/\\evil.com",
      "redirect_uri=javascript:alert(1)",
      "state=//evil.com&code=x",
      "state=https://evil.com/%3F&code=x",
    ];
    for (const extra of attempts) {
      // Six flows: more than one account's five.
      who = await fresh();
      const flow = await start();
      const response = await callback(
        `state=${encodeURIComponent(flow.state)}&code=${oauth.authCode}&${extra}`,
      );
      const location = response.headers.get("location")!;
      expect(location).toStartWith("/settings/origins?");
      expect(location.startsWith("//")).toBe(false);
      expect(location).not.toContain("evil.com");
      expect(location).not.toContain("javascript:");
      // Delete the connection so the next attempt is not "already connected".
      app.db.query("DELETE FROM origin").run();
    }
    // A bogus state with a redirect-looking payload is the fixed answer too.
    const bogus = await callback("state=//evil.com&code=x&redirect=//evil.com");
    expect(bogus.headers.get("location")).toBe("/settings/origins?error=state");
  });

  test("the registered redirect_uri comes from FORGE_URL, never the Host header", async () => {
    app.db.query("DELETE FROM origin").run();
    process.env.FORGE_URL = "https://forge.example.test/";
    const response = await api("/api/v1/user/origins/oauth", {
      method: "POST",
      headers: {
        host: "evil.com",
        "x-forwarded-host": "evil.com",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({ host: fake.url }),
    });
    expect(response.status).toBe(201);
    const started = await read<{ flowId: string; url: string }>(response);
    const redirectUri = new URL(started.url).searchParams.get("redirect_uri")!;
    expect(redirectUri).toBe(`https://forge.example.test${CALLBACK}`);
    expect(started.url).not.toContain("evil.com");
    const stored = app.db
      .query<
        { redirect_uri: string },
        [string]
      >("SELECT redirect_uri FROM oauth_flow WHERE id = ?1")
      .get(started.flowId)!;
    expect(stored.redirect_uri).toBe(`https://forge.example.test${CALLBACK}`);

    // Without a configured public URL, a non-loopback Host is not trusted:
    // the flow is refused rather than registering a stranger's callback.
    delete process.env.FORGE_URL;
    const spoofed = await api("/api/v1/user/origins/oauth", {
      method: "POST",
      headers: { host: "evil.com" },
      body: JSON.stringify({ host: fake.url }),
    });
    expect(spoofed.status).toBe(422);
    expect((await read<{ error: string }>(spoofed)).error).toBe("no_app");
    expect(
      app.db
        .query<
          { n: number },
          []
        >("SELECT COUNT(*) AS n FROM oauth_flow WHERE redirect_uri LIKE '%evil.com%'")
        .get()!.n,
    ).toBe(0);

    // Loopback (the dev case) still works with no configuration at all.
    const local = await start();
    expect(local.redirectUri).toBe(`${base}${CALLBACK}`);

    // The resolver itself: FORGE_URL wins, a vouched FORGE_HOST is accepted,
    // and anything else — including a non-http FORGE_URL — yields nothing.
    const evil = new URL("http://evil.com/api/v1/user/origins/oauth");
    expect(oauthCallbackUri(evil, undefined, {})).toBe("");
    expect(oauthCallbackUri(evil, "forge.lan", {})).toBe("");
    expect(
      oauthCallbackUri(new URL("http://forge.lan:3000/x"), "forge.lan", {}),
    ).toBe(`http://forge.lan:3000${CALLBACK}`);
    expect(
      oauthCallbackUri(evil, undefined, { FORGE_URL: "https://forge.example" }),
    ).toBe(`https://forge.example${CALLBACK}`);
    expect(
      oauthCallbackUri(evil, undefined, { FORGE_URL: "javascript:alert(1)" }),
    ).toBe("");
    expect(oauthCallbackUri(evil, undefined, { FORGE_URL: "not a url" })).toBe(
      "",
    );
  });

  test("the audit trail carries no state, code, verifier or token", () => {
    const text = JSON.stringify(listEvents(app.db, { limit: 500 }));
    expect(text).not.toContain(oauth.authCode);
    expect(text).not.toContain(oauth.accessToken);
    expect(text).not.toContain(oauth.refreshToken);
    for (const row of app.db
      .query<
        { redirect_uri: string },
        []
      >("SELECT redirect_uri FROM oauth_flow")
      .all())
      expect(row.redirect_uri).not.toContain("evil.com");
    for (const request of oauth.tokenRequests) {
      if (request.code_verifier !== undefined)
        expect(text).not.toContain(request.code_verifier);
    }
  });
});

// ----------------------------------------------------------- device flow

describe("OAuth device flow: a flow is private to the user who started it", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let fake: FakeForge;
  let oauth: FakeOAuth;
  let api: Caller;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-sec-device-"));
    const state = newFakeState("github", LOGIN, ORIGIN_TOKEN);
    oauth = newFakeOAuth(CLIENT_ID);
    state.oauth = oauth;
    fake = serveFakeForge(state);
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    setLimit(app.db, "signup.per_source", 1000, "setup");
    api = callerFor(servers.url);
    await createUsers(servers.url, ["alice", "bob"]);
    proveAll(app);
    forgetProviders(dataDir);
    process.env.FORGE_GITHUB_CLIENT_ID = CLIENT_ID;
  });
  afterAll(async () => {
    delete process.env.FORGE_GITHUB_CLIENT_ID;
    fake.stop();
    servers.stop();
    app.close();
    forgetProviders(dataDir);
    await rm(dataDir, { recursive: true, force: true });
  });

  test("user B cannot poll, advance, or complete user A's device code", async () => {
    const started = await read<{ flowId: string }>(
      await api("/api/v1/user/origins/oauth", {
        method: "POST",
        body: JSON.stringify({ host: fake.url, kind: "github" }),
      }),
    );
    const polls = () =>
      oauth.tokenRequests.filter(
        (r) => r.grant_type === "urn:ietf:params:oauth:grant-type:device_code",
      ).length;
    const before = polls();

    // Bob polling Alice's flow: not found, and the forge did not poll the
    // provider on his behalf.
    const bob = await api(`/api/v1/user/origins/oauth/${started.flowId}`, {
      as: "bob",
    });
    expect(bob.status).toBe(404);
    expect(polls()).toBe(before);

    // The human approves. Bob still cannot complete it, and no credential
    // lands on him.
    oauth.approved = true;
    expect(
      (await api(`/api/v1/user/origins/oauth/${started.flowId}`, { as: "bob" }))
        .status,
    ).toBe(404);
    expect(polls()).toBe(before);
    expect(originCount(app)).toBe(0);
    // Anonymous is refused too.
    expect(
      (
        await api(`/api/v1/user/origins/oauth/${started.flowId}`, {
          none: true,
        })
      ).status,
    ).toBe(401);

    // Alice completes it; the origin is hers.
    const done = await read<{ status: string; originId: string }>(
      await api(`/api/v1/user/origins/oauth/${started.flowId}`),
    );
    expect(done.status).toBe("done");
    const origin = getOriginById(app.db, done.originId)!;
    expect(origin.userId).toBe(
      app.db
        .query<
          { id: string },
          [string]
        >("SELECT id FROM user WHERE username = ?1")
        .get("alice")!.id,
    );
    // The bare flow id is not a handle anyone else can use afterwards either.
    expect(
      (await api(`/api/v1/user/origins/oauth/${started.flowId}`, { as: "bob" }))
        .status,
    ).toBe(404);
  });
});

// ------------------------------------------------- refresh + needs_reauth

describe("refresh serialisation and needs_reauth", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let fake: FakeForge;
  let oauth: FakeOAuth;
  let api: Caller;
  let originId = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-sec-refresh-"));
    const state = newFakeState("forgejo", LOGIN, ORIGIN_TOKEN);
    oauth = newFakeOAuth(CLIENT_ID);
    state.oauth = oauth;
    state.repos.push({
      id: 51,
      fullName: "octo/widgets",
      // Nothing listens here: git fetches fail fast, which is fine — these
      // tests count API requests, not git ones.
      cloneUrl: "http://127.0.0.1:1/octo/widgets.git",
    });
    state.issues.set("octo/widgets", [
      {
        id: 900,
        number: 1,
        title: "first",
        user: "mona",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    fake = serveFakeForge(state);
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    setLimit(app.db, "signup.per_source", 1000, "setup");
    api = callerFor(servers.url);
    await createUsers(servers.url, ["alice"]);
    proveAll(app);
    forgetProviders(dataDir);
    await api("/api/v1/user/origin-apps", {
      method: "POST",
      body: JSON.stringify({ host: fake.url, clientId: CLIENT_ID }),
    });
    const started = await read<{ url: string }>(
      await api("/api/v1/user/origins/oauth", {
        method: "POST",
        body: JSON.stringify({ host: fake.url }),
      }),
    );
    const flowState = new URL(started.url).searchParams.get("state")!;
    await api(
      `${CALLBACK}?state=${encodeURIComponent(flowState)}&code=${oauth.authCode}`,
    );
    originId = app.db.query<{ id: string }, []>("SELECT id FROM origin").get()!
      .id;
    const mirrored = await api(`/api/v1/user/origins/${originId}/mirror`, {
      method: "POST",
      body: JSON.stringify({ fullName: "octo/widgets" }),
    });
    expect(mirrored.status).toBe(202);
    // The git side is deliberately unreachable here, so the job ends
    // `failed` on the fetch — the repository and its imported rows exist
    // either way, which is what these tests go on to count.
    const job = await mirrorAndWait(mirrored);
    expect(job?.stage).toBe("failed");
    expect(job?.repo?.name).toBe("widgets");
  });
  afterAll(async () => {
    fake.stop();
    servers.stop();
    app.close();
    forgetProviders(dataDir);
    await rm(dataDir, { recursive: true, force: true });
  });

  const expire = (): void => {
    app.db
      .query("UPDATE origin SET expires_at = ?1 WHERE id = ?2")
      .run(new Date(Date.now() - 1000).toISOString(), originId);
  };
  const refreshes = () =>
    oauth.tokenRequests.filter((r) => r.grant_type === "refresh_token").length;

  test("twenty concurrent provider calls on an expiring credential refresh exactly once", async () => {
    expire();
    const before = refreshes();
    const provider = providerForOrigin(app, getOriginById(app.db, originId)!);
    expect(provider.ok).toBe(true);
    if (!provider.ok) return;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => provider.value.whoami()),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(refreshes() - before).toBe(1);
    // Every call authenticated with the refreshed token, not the stale one.
    const bearers = fake.state.requests
      .filter((r) => r.path.endsWith("/user"))
      .slice(-20)
      .map((r) => r.authorization);
    expect(new Set(bearers)).toEqual(new Set([`Bearer ${oauth.accessToken}`]));
  });

  test("needs_reauth stops sync, the picker, and write-through from touching the provider", async () => {
    app.db
      .query("UPDATE origin SET needs_reauth = 1 WHERE id = ?1")
      .run(originId);
    const apiCalls = () => fake.state.requests.length;
    const before = apiCalls();
    const tokenCalls = oauth.tokenRequests.length;

    // The origin is not due, and an explicit sync makes no request.
    expect(dueOrigins(app).map((o) => o.id)).not.toContain(originId);
    const synced = await api(`/api/v1/user/origins/${originId}/sync`, {
      method: "POST",
    });
    expect(synced.status).toBe(200);
    expect((await read<{ error: string }>(synced)).error).toContain(
      "reconnected",
    );
    const repoSync = await api("/api/v1/repos/alice/widgets/sync", {
      method: "POST",
    });
    expect(repoSync.status).toBe(200);
    expect(apiCalls()).toBe(before);

    // Write-through fails closed: nothing goes upstream, nothing lands here.
    const comment = await api("/api/v1/repos/alice/widgets/issues/1/comments", {
      method: "POST",
      body: JSON.stringify({ body: "should never travel" }),
    });
    expect([409, 502]).toContain(comment.status);
    expect(apiCalls()).toBe(before);
    expect(
      app.db
        .query<
          { n: number },
          []
        >("SELECT COUNT(*) AS n FROM comment WHERE body = 'should never travel'")
        .get()!.n,
    ).toBe(0);
    expect(fake.state.comments.get("octo/widgets") ?? []).toHaveLength(0);

    // The picker refresh does not spend the credential either.
    await api(`/api/v1/user/origins/${originId}/repos?refresh=1`);
    expect(apiCalls()).toBe(before);
    // And no refresh was attempted for a credential a human must renew.
    expect(oauth.tokenRequests.length).toBe(tokenCalls);
    expect(getOriginById(app.db, originId)!.needsReauth).toBe(true);
  });
});

// ---------------------------------------------------------- authorization

describe("authorization across origins, mirrors, pins and disconnect", () => {
  let dataDir: string;
  let upstreamDataDir: string;
  let app: App;
  let servers: Servers;
  let upstream: App;
  let upstreamServers: Servers;
  let fake: FakeForge;
  let base: string;
  let api: Caller;
  let originId = "";
  let appId = "";
  const bodies: string[] = [];
  const secrets: string[] = [ORIGIN_TOKEN, CLIENT_SECRET];

  /** An API call whose body is kept for the leak sweep. */
  const seen = async (response: Response): Promise<Response> => {
    const copy = response.clone();
    bodies.push(await copy.text());
    return response;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-sec-authz-"));
    upstreamDataDir = await mkdtemp(join(tmpdir(), "forge-sec-upstream-"));

    // The git host the mirrors fetch from: a second real forge.
    upstream = createApp({ dataDir: upstreamDataDir, port: 0 });
    upstreamServers = await serve(upstream);
    await seedAdmin(upstream, {
      username: LOGIN,
      email: "octo@upstream.test",
      password: ORIGIN_TOKEN,
    });
    for (const name of ["widgets", "secret"]) {
      await fetch(`${upstreamServers.url}/api/v1/repos`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basic(LOGIN, ORIGIN_TOKEN),
        },
        body: JSON.stringify({ name, visibility: "public" }),
      });
      await fetch(`${upstreamServers.url}/api/v1/repos/octo/${name}/contents`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basic(LOGIN, ORIGIN_TOKEN),
        },
        body: JSON.stringify({
          branch: "main",
          message: "first",
          files: [{ path: "README.md", content: `# ${name}\n` }],
        }),
      });
    }

    const state = newFakeState("forgejo", LOGIN, ORIGIN_TOKEN);
    state.repos.push(
      {
        id: 41,
        fullName: "octo/widgets",
        cloneUrl: `${upstreamServers.url}/octo/widgets.git`,
        htmlUrl: `${upstreamServers.url}/octo/widgets`,
      },
      {
        id: 42,
        fullName: "octo/secret",
        private: true,
        cloneUrl: `${upstreamServers.url}/octo/secret.git`,
        htmlUrl: `${upstreamServers.url}/octo/secret`,
      },
    );
    state.issues.set("octo/widgets", [
      {
        id: 900,
        number: 7,
        title: "The gear slips",
        user: "mona",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
    fake = serveFakeForge(state);

    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    api = callerFor(base);
    // Bob is the site admin, which makes him a writer of every repo — the
    // one kind of non-owner writer a personal mirror can have.
    await seedAdmin(app, { username: "bob", email: "bob@forge.test", password: PASSWORD });
    await createUsers(base, ["alice", "carol"]);
    proveAll(app);
    forgetProviders(dataDir);

    const registered = await seen(
      await api("/api/v1/user/origin-apps", {
        method: "POST",
        body: JSON.stringify({
          host: fake.url,
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
        }),
      }),
    );
    appId = (await read<{ id: string }>(registered)).id;
    const connected = await seen(
      await api("/api/v1/user/origins", {
        method: "POST",
        body: JSON.stringify({ host: fake.url, token: ORIGIN_TOKEN }),
      }),
    );
    expect(connected.status).toBe(201);
    originId = (await read<{ id: string }>(connected)).id;
    for (const fullName of ["octo/widgets", "octo/secret"]) {
      const mirrored = await seen(
        await api(`/api/v1/user/origins/${originId}/mirror`, {
          method: "POST",
          body: JSON.stringify({ fullName }),
        }),
      );
      expect(mirrored.status).toBe(202);
      expect((await mirrorAndWait(mirrored))?.stage).toBe("done");
    }
    // The ciphertexts are secrets too: an API that echoed one would hand a
    // key-holder the credential.
    const sealed = sealedSecrets(app.db, originId)!;
    secrets.push(sealed.token);
    const appRow = app.db
      .query<
        { client_secret_enc: string },
        [string]
      >("SELECT client_secret_enc FROM origin_app WHERE id = ?1")
      .get(appId)!;
    secrets.push(appRow.client_secret_enc);
  });
  afterAll(async () => {
    fake.stop();
    servers.stop();
    upstreamServers.stop();
    app.close();
    upstream.close();
    forgetProviders(dataDir);
    await rm(dataDir, { recursive: true, force: true });
    await rm(upstreamDataDir, { recursive: true, force: true });
  });

  test("every origin and app route refuses ro and rw tokens; an admin token passes the gate", async () => {
    const ro = await mintToken(base, "alice", "ro");
    const rw = await mintToken(base, "alice", "rw");
    const admin = await mintToken(base, "alice", "admin");
    const routes: { method: string; path: string; body?: unknown }[] = [
      { method: "GET", path: "/api/v1/user/origins" },
      {
        method: "POST",
        path: "/api/v1/user/origins",
        body: { host: fake.url, token: "wrong" },
      },
      {
        method: "POST",
        path: "/api/v1/user/origins/oauth",
        body: { host: fake.url },
      },
      { method: "GET", path: "/api/v1/user/origins/oauth/no-such-flow" },
      { method: "GET", path: "/api/v1/user/origin-apps" },
      {
        method: "POST",
        path: "/api/v1/user/origin-apps",
        body: { host: fake.url, clientId: CLIENT_ID },
      },
      { method: "DELETE", path: "/api/v1/user/origin-apps/no-such-app" },
      { method: "DELETE", path: "/api/v1/user/origins/no-such-origin" },
      { method: "POST", path: `/api/v1/user/origins/${originId}/sync` },
      { method: "GET", path: `/api/v1/user/origins/${originId}/repos` },
      {
        method: "POST",
        path: `/api/v1/user/origins/${originId}/mirror`,
        body: { fullName: "octo/nope" },
      },
    ];
    for (const route of routes) {
      for (const token of [ro, rw]) {
        const response = await seen(
          await api(route.path, {
            method: route.method,
            token,
            ...(route.body === undefined
              ? {}
              : { body: JSON.stringify(route.body) }),
          }),
        );
        expect(`${route.method} ${route.path} ${response.status}`).toBe(
          `${route.method} ${route.path} 403`,
        );
      }
      // The floor is the account; an explicit admin token is the account.
      const allowed = await seen(
        await api(route.path, {
          method: route.method,
          token: admin,
          ...(route.body === undefined
            ? {}
            : { body: JSON.stringify(route.body) }),
        }),
      );
      expect([401, 403]).not.toContain(allowed.status);
      // No credentials at all is never enough.
      const anonymous = await api(route.path, {
        method: route.method,
        none: true,
      });
      expect(anonymous.status).toBe(401);
    }

    // Pins and per-repo sync are repo-level: rw is the floor, ro is refused.
    for (const [method, path] of [
      ["PUT", "/api/v1/user/pins/alice/widgets"],
      ["DELETE", "/api/v1/user/pins/alice/widgets"],
      ["POST", "/api/v1/repos/alice/widgets/sync"],
    ] as const) {
      expect((await api(path, { method, token: ro })).status).toBe(403);
      expect((await api(path, { method, none: true })).status).toBe(401);
    }
    expect(
      (
        await api("/api/v1/user/pins/alice/widgets", {
          method: "PUT",
          token: rw,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api("/api/v1/user/pins/alice/widgets", {
          method: "DELETE",
          token: rw,
        })
      ).status,
    ).toBe(204);
    expect((await api("/api/v1/user/pins", { none: true })).status).toBe(401);
  });

  test("another user's origin, flow and app are not_found on every route — even for a site admin", async () => {
    const flow = await read<{ flowId: string }>(
      await api("/api/v1/user/origins/oauth", {
        method: "POST",
        body: JSON.stringify({ host: fake.url }),
      }),
    );
    const probes: { method: string; path: string; body?: unknown }[] = [
      { method: "GET", path: `/api/v1/user/origins/oauth/${flow.flowId}` },
      { method: "DELETE", path: `/api/v1/user/origin-apps/${appId}` },
      { method: "DELETE", path: `/api/v1/user/origins/${originId}` },
      { method: "POST", path: `/api/v1/user/origins/${originId}/sync` },
      { method: "GET", path: `/api/v1/user/origins/${originId}/repos` },
      {
        method: "POST",
        path: `/api/v1/user/origins/${originId}/mirror`,
        body: { fullName: "octo/widgets" },
      },
    ];
    for (const as of ["carol", "bob"]) {
      for (const probe of probes) {
        const response = await seen(
          await api(probe.path, {
            method: probe.method,
            as,
            ...(probe.body === undefined
              ? {}
              : { body: JSON.stringify(probe.body) }),
          }),
        );
        expect(`${as} ${probe.method} ${probe.path} ${response.status}`).toBe(
          `${as} ${probe.method} ${probe.path} 404`,
        );
        expect((await read<{ error: string }>(response)).error).toBe(
          "not_found",
        );
      }
      expect(
        await read<unknown[]>(await api("/api/v1/user/origins", { as })),
      ).toEqual([]);
      expect(
        await read<unknown[]>(await api("/api/v1/user/origin-apps", { as })),
      ).toEqual([]);
    }
    // Nothing was deleted or spent by any of that.
    expect(getOriginById(app.db, originId)).toBeDefined();
    expect(
      app.db.query("SELECT 1 FROM origin_app WHERE id = ?1").get(appId),
    ).not.toBeNull();
  });

  test("a non-owner writer of a mirror cannot write through it", async () => {
    // Bob is the site admin: canWrite says yes to alice/widgets.
    const before = JSON.stringify(fake.state.issues.get("octo/widgets"));
    const comments = fake.state.comments.get("octo/widgets")?.length ?? 0;
    const attempts: [string, string, unknown][] = [
      ["POST", "/api/v1/repos/alice/widgets/issues", { title: "from bob" }],
      [
        "POST",
        "/api/v1/repos/alice/widgets/issues/7/comments",
        { body: "from bob" },
      ],
      ["PATCH", "/api/v1/repos/alice/widgets/issues/7", { state: "closed" }],
      [
        "PUT",
        "/api/v1/repos/alice/widgets/issues/7/labels",
        { labels: ["bug"] },
      ],
      [
        "POST",
        "/api/v1/repos/alice/widgets/pulls",
        { title: "from bob", base: "main", head: "topic" },
      ],
    ];
    for (const [method, path, body] of attempts) {
      const response = await api(path, {
        method,
        as: "bob",
        body: JSON.stringify(body),
      });
      // The pull route maps the refusal through `respondAccess` rather than
      // `originAware`, so it answers 422 where the issue routes answer 403;
      // the refusal itself is the same and nothing travels.
      expect([403, 422]).toContain(response.status);
      expect((await read<{ error: string }>(response)).error).toBe(
        "origin_owner_only",
      );
    }
    expect(JSON.stringify(fake.state.issues.get("octo/widgets"))).toBe(before);
    expect(fake.state.comments.get("octo/widgets")?.length ?? 0).toBe(comments);
    expect(
      app.db
        .query<
          { n: number },
          []
        >("SELECT COUNT(*) AS n FROM issue WHERE title = 'from bob'")
        .get()!.n,
    ).toBe(0);
  });

  test("a reader cannot sync a mirror or mirror from someone else's origin", async () => {
    const requests = fake.state.requests.length;
    const publicSync = await api("/api/v1/repos/alice/widgets/sync", {
      method: "POST",
      as: "carol",
    });
    expect(publicSync.status).toBe(403);
    const privateSync = await api("/api/v1/repos/alice/secret/sync", {
      method: "POST",
      as: "carol",
    });
    expect(privateSync.status).toBe(404);
    expect(
      (
        await api(`/api/v1/user/origins/${originId}/mirror`, {
          method: "POST",
          as: "carol",
          body: JSON.stringify({ fullName: "octo/widgets", name: "mine" }),
        })
      ).status,
    ).toBe(404);
    expect(fake.state.requests.length).toBe(requests);
    expect(getRepo(app.db, "carol", "mine")).toBeUndefined();
  });

  test("pins are scoped per user and never reveal a repo the pinner cannot read", async () => {
    expect(
      (await api("/api/v1/user/pins/alice/widgets", { method: "PUT" })).status,
    ).toBe(200);
    expect(
      (await api("/api/v1/user/pins/alice/secret", { method: "PUT" })).status,
    ).toBe(200);
    // Carol sees none of Alice's pins, cannot remove them, and cannot pin a
    // repo she cannot see — which does not exist for her.
    expect(
      (
        await read<{ items: unknown[] }>(
          await seen(await api("/api/v1/user/pins", { as: "carol" })),
        )
      ).items,
    ).toEqual([]);
    expect(
      (
        await api("/api/v1/user/pins/alice/widgets", {
          method: "DELETE",
          as: "carol",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api("/api/v1/user/pins/alice/secret", {
          method: "PUT",
          as: "carol",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api("/api/v1/user/pins/alice/secret", {
          method: "DELETE",
          as: "carol",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await read<{ items: unknown[] }>(
          await api("/api/v1/user/pins", { as: "bob" }),
        )
      ).items,
    ).toEqual([]);
    const mine = await read<{ items: { name: string }[] }>(
      await seen(await api("/api/v1/user/pins")),
    );
    expect(mine.items.map((p) => p.name).sort()).toEqual(["secret", "widgets"]);
    expect(
      app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM pin").get()!.n,
    ).toBe(2);
  });

  test("a private origin repo is a private mirror: invisible to guests and strangers, over the API and git", async () => {
    const repo = await read<{ visibility: string }>(
      await seen(await api("/api/v1/repos/alice/secret")),
    );
    expect(repo.visibility).toBe("private");

    for (const init of [{ none: true }, { as: "carol" }] as const) {
      const shown = await api("/api/v1/repos/alice/secret", init);
      expect(shown.status).toBe(404);
      const issues = await api("/api/v1/repos/alice/secret/issues", init);
      expect(issues.status).toBe(404);
      const refs = await api(
        "/alice/secret.git/info/refs?service=git-upload-pack",
        init,
      );
      // A guest gets the challenge git needs; a signed-in stranger gets the
      // same 404 a missing repo would.
      expect(refs.status).toBe("none" in init ? 401 : 404);
      expect(await refs.text()).not.toContain("refs/heads");
    }
    // The owner can clone it.
    const own = await api(
      "/alice/secret.git/info/refs?service=git-upload-pack",
    );
    expect(own.status).toBe(200);
    expect(await own.text()).toContain("refs/heads/main");
  });

  test("visibility follows the origin on sync, explicitly: narrowing hides the repo at once", async () => {
    const remote = fake.state.repos.find((r) => r.fullName === "octo/widgets")!;
    expect(getRepo(app.db, "alice", "widgets")!.visibility).toBe("public");

    // Upstream goes private: the mirror goes private and a guest loses it.
    remote.private = true;
    expect(
      (await api(`/api/v1/user/origins/${originId}/sync`, { method: "POST" }))
        .status,
    ).toBe(200);
    expect(getRepo(app.db, "alice", "widgets")!.visibility).toBe("private");
    expect(
      (await api("/api/v1/repos/alice/widgets", { none: true })).status,
    ).toBe(404);
    // The settings trail says from what to what, in the one shape every writer uses.
    const narrowed = listEvents(app.db, { kind: "repo.settings_updated", limit: 1 })[0]!;
    expect(narrowed.payload["changed"]).toEqual({ visibility: { from: "public", to: "private" } });

    // Upstream goes public again. The sync does NOT widen the mirror back:
    // narrowing is the origin's call to make for us, widening is the owner's
    // to make here, so a mistaken or hostile origin can never publish a repo.
    const events = listEvents(app.db, { limit: 500 }).length;
    remote.private = false;
    await api(`/api/v1/user/origins/${originId}/sync`, { method: "POST" });
    expect(getRepo(app.db, "alice", "widgets")!.visibility).toBe("private");
    const announced = listEvents(app.db, { limit: 500 })
      .slice(0, listEvents(app.db, { limit: 500 }).length - events)
      .filter((e) => e.kind === "repo.settings_updated");
    expect(announced).toHaveLength(0);
  });

  test("no origin, app, pin, repo or sync response carries a credential in any form", async () => {
    for (const path of [
      "/api/v1/user/origins",
      "/api/v1/user/origin-apps",
      `/api/v1/user/origins/${originId}/repos`,
      `/api/v1/user/origins/${originId}/repos?refresh=1`,
      "/api/v1/user/pins",
      "/api/v1/repos/alice/widgets",
      "/api/v1/repos/alice/widgets/issues?state=all",
      "/api/v1/repos/alice/widgets/issues/7",
    ])
      await seen(await api(path));
    await seen(
      await api(`/api/v1/user/origins/${originId}/sync`, { method: "POST" }),
    );
    await seen(
      await api("/api/v1/repos/alice/widgets/sync", { method: "POST" }),
    );
    expect(bodies.length).toBeGreaterThan(20);

    const encoded = (value: string) => [
      value,
      Buffer.from(value).toString("base64"),
      Buffer.from(value).toString("base64url"),
      basic(LOGIN, value),
    ];
    for (const body of bodies) {
      for (const secret of secrets)
        for (const form of encoded(secret)) expect(body).not.toContain(form);
      expect(body).not.toMatch(
        /"(token|token_enc|refresh_token|client_secret|clientSecret|refresh_token_enc|client_secret_enc)"\s*:/,
      );
    }
    // The apps list says only whether a secret exists.
    const apps = await read<Record<string, unknown>[]>(
      await api("/api/v1/user/origin-apps"),
    );
    expect(apps).toHaveLength(1);
    expect(apps[0]!.hasSecret).toBe(true);
    expect(Object.keys(apps[0]!)).not.toContain("clientSecret");
    // Nor does the audit trail.
    const events = JSON.stringify(listEvents(app.db, { limit: 500 }));
    for (const secret of secrets) expect(events).not.toContain(secret);
  });

  test("disconnecting destroys the sealed credential; mirrors stay readable and stop syncing", async () => {
    const sealed = sealedSecrets(app.db, originId)!;
    const gone = await seen(
      await api(`/api/v1/user/origins/${originId}`, { method: "DELETE" }),
    );
    expect(gone.status).toBe(200);

    // The row — and with it the only copy of the ciphertext — is gone.
    expect(sealedSecrets(app.db, originId)).toBeUndefined();
    expect(getOriginById(app.db, originId)).toBeUndefined();
    expect(
      app.db
        .query<
          { n: number },
          []
        >("SELECT COUNT(*) AS n FROM oauth_flow WHERE origin_id IS NOT NULL")
        .get()!.n,
    ).toBe(0);
    // The plaintext was never in the file; after the delete the ciphertext
    // is not in the live pages either.
    app.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const bytes = await readFile(join(dataDir, "forge.db"));
    expect(bytes.includes(Buffer.from(ORIGIN_TOKEN))).toBe(false);
    const live = app.db
      .query<{ hit: number }, [string]>(
        `SELECT COUNT(*) AS hit FROM (
           SELECT token_enc AS v FROM origin
           UNION ALL SELECT refresh_token_enc FROM origin
           UNION ALL SELECT client_secret_enc FROM oauth_flow
           UNION ALL SELECT device_code_enc FROM oauth_flow
           UNION ALL SELECT verifier_enc FROM oauth_flow
         ) WHERE v = ?1`,
      )
      .get(sealed.token)!.hit;
    expect(live).toBe(0);

    // A second disconnect is not_found; nobody else's either.
    expect(
      (await api(`/api/v1/user/origins/${originId}`, { method: "DELETE" }))
        .status,
    ).toBe(404);

    // Mirrors remain, readable, un-linked, and out of the sync sweep: frozen,
    // and said to be (#1090), with no origin id left to name.
    for (const name of ["widgets", "secret"]) {
      const repo = await read<{ origin: unknown; visibility: string }>(
        await api(`/api/v1/repos/alice/${name}`),
      );
      expect(repo.origin).toMatchObject({ originId: null, detached: true });
    }
    expect(getRepo(app.db, "alice", "secret")!.visibility).toBe("private");
    expect(
      (await api("/api/v1/repos/alice/secret", { none: true })).status,
    ).toBe(404);
    expect(dueOrigins(app)).toEqual([]);
    const requests = fake.state.requests.length;
    expect(
      (await api("/api/v1/repos/alice/widgets/sync", { method: "POST" }))
        .status,
    ).toBe(404);
    expect(
      (await api(`/api/v1/user/origins/${originId}/sync`, { method: "POST" }))
        .status,
    ).toBe(404);
    expect(fake.state.requests.length).toBe(requests);
  });
});
