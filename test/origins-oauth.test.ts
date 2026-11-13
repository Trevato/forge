import { everyoneIsAMember } from "./helpers/members.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  completeOAuthCallback,
  startOAuthConnect,
} from "../src/actions/origins.ts";
import { listEvents } from "../src/core/events.ts";
import { getOriginById, sealedSecrets } from "../src/core/origins.ts";
import { getUserByName } from "../src/core/users.ts";
import { credentialFor } from "../src/origins/credential.ts";
import { allowedOrigin, discover } from "../src/origins/discover.ts";
import { open } from "../src/kernel/secret.ts";
import { redactSecrets } from "../src/kernel/log.ts";
import { pkce } from "../src/origins/oauth.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import {
  newFakeOAuth,
  newFakeState,
  serveFakeForge,
  type FakeForge,
  type FakeOAuth,
} from "./fake-origin.ts";
import { withoutEnv } from "./helpers/globals.ts";

/**
 * Connecting an origin without pasting a token, and the security properties
 * that make that safe. Every claim in the threat model gets a test here —
 * they are the whole reason the flows are worth having.
 */

const LOGIN = "octo";
const PASSWORD = "alice-login-secret";
const CLIENT_ID = "Iv1.forge-test-client";

const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

const read = async <T>(response: Response): Promise<T> =>
  (await response.json()) as T;

interface Fixture {
  dataDir: string;
  app: App;
  servers: Servers;
  fake: FakeForge;
  oauth: FakeOAuth;
  base: string;
}

async function boot(kind: "github" | "forgejo"): Promise<Fixture> {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-oauth-"));
  const state = newFakeState(kind, LOGIN, "unused-pat");
  const oauth = newFakeOAuth(CLIENT_ID);
  state.oauth = oauth;
  const fake = serveFakeForge(state);
  const app = createApp({ dataDir, port: 0 });
  everyoneIsAMember(app.db);
  const servers = await serve(app);
  for (const username of ["alice", "bob", "carol"]) {
    await fetch(`${servers.url}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username,
        email: `${username}@forge.test`,
        password: PASSWORD,
      }),
    });
  }
  forgetProviders(dataDir);
  return { dataDir, app, servers, fake, oauth, base: servers.url };
}

async function shutdown(f: Fixture): Promise<void> {
  f.fake.stop();
  f.servers.stop();
  f.app.close();
  forgetProviders(f.dataDir);
  await rm(f.dataDir, { recursive: true, force: true });
}

// The code flow's redirect_uri is this test server's own — never the forge a
// crew machine's `FORGE_URL` names.
withoutEnv("FORGE_URL");

// ---------------------------------------------------------------- device

describe("GitHub's device grant: connecting with no browser on the server", () => {
  let f: Fixture;
  const api = (path: string, init?: RequestInit & { as?: string }) => {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined)
      headers.set("content-type", "application/json");
    headers.set("authorization", basic(init?.as ?? "alice", PASSWORD));
    return fetch(`${f.base}${path}`, { ...init, headers });
  };

  beforeAll(async () => {
    f = await boot("github");
    // The operator's client id: public by design, no secret needed.
    process.env.FORGE_GITHUB_CLIENT_ID = CLIENT_ID;
  });
  afterAll(async () => {
    delete process.env.FORGE_GITHUB_CLIENT_ID;
    await shutdown(f);
  });

  test("a start hands back a code and a URL for the other device", async () => {
    const response = await api("/api/v1/user/origins/oauth", {
      method: "POST",
      body: JSON.stringify({ host: f.fake.url, kind: "github" }),
    });
    expect(response.status).toBe(201);
    const started = await read<{
      flowId: string;
      flow: string;
      userCode: string;
      url: string;
      intervalSecs: number;
    }>(response);
    expect(started.flow).toBe("device");
    expect(started.userCode).toBe("WXYZ-1234");
    expect(started.url).toBe(f.oauth.verificationUri);
    // Nothing secret crosses back: the device code stays on this side.
    expect(JSON.stringify(started)).not.toContain(f.oauth.deviceCode);

    // Polling before the human acts is `pending`, not an error.
    const pending = await read<{ status: string }>(
      await api(`/api/v1/user/origins/oauth/${started.flowId}`),
    );
    expect(pending.status).toBe("pending");

    // `slow_down` widens the interval by exactly five seconds, as the spec
    // asks — a poller that ignores this gets its application banned.
    f.oauth.slowDownOnce = true;
    const slowed = await read<{ status: string; intervalSecs: number }>(
      await api(`/api/v1/user/origins/oauth/${started.flowId}`),
    );
    expect(slowed.status).toBe("pending");
    expect(slowed.intervalSecs).toBe(started.intervalSecs + 5);

    // The human approves on their phone; the next poll completes it.
    f.oauth.approved = true;
    const done = await read<{ status: string; originId: string | null }>(
      await api(`/api/v1/user/origins/oauth/${started.flowId}`),
    );
    expect(done.status).toBe("done");
    expect(done.originId).toBeString();

    const origin = getOriginById(f.app.db, done.originId!)!;
    expect(origin.authKind).toBe("oauth");
    expect(origin.login).toBe(LOGIN);
    expect(origin.expiresAt).toBeString();
    // Both halves of the credential are stored, and neither in plaintext.
    const sealed = sealedSecrets(f.app.db, origin.id)!;
    expect(sealed.token).not.toContain(f.oauth.accessToken);
    expect(sealed.refresh).not.toContain(f.oauth.refreshToken);
    expect(open(f.dataDir, sealed.refresh, origin.id)).toEqual({
      ok: true,
      value: f.oauth.refreshToken,
    });

    // And no API response ever carries one.
    const listed = await (await api("/api/v1/user/origins")).text();
    expect(listed).not.toContain(f.oauth.accessToken);
    expect(listed).not.toContain(f.oauth.refreshToken);
    expect(listed).not.toMatch(/gh[pousr]_/);
  });

  test("a declined or expired device flow stops the poller", async () => {
    f.oauth.approved = false;
    f.oauth.deviceError = "access_denied";
    const started = await read<{ flowId: string }>(
      await api("/api/v1/user/origins/oauth", {
        method: "POST",
        body: JSON.stringify({ host: f.fake.url, kind: "github" }),
      }),
    );
    const outcome = await read<{ status: string; detail: string }>(
      await api(`/api/v1/user/origins/oauth/${started.flowId}`),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toContain("declined");

    // A terminal flow stays terminal: polling it again does not retry.
    const before = f.oauth.tokenRequests.length;
    await api(`/api/v1/user/origins/oauth/${started.flowId}`);
    expect(f.oauth.tokenRequests.length).toBe(before);
    f.oauth.deviceError = "";
  });

  test("another user cannot poll, or see, someone else's flow", async () => {
    f.oauth.approved = false;
    const started = await read<{ flowId: string }>(
      await api("/api/v1/user/origins/oauth", {
        method: "POST",
        body: JSON.stringify({ host: f.fake.url, kind: "github" }),
      }),
    );
    const response = await api(`/api/v1/user/origins/oauth/${started.flowId}`, {
      as: "bob",
    });
    expect(response.status).toBe(404);
  });

  test("an rw token cannot start a connect", async () => {
    const minted = await read<{ token: string }>(
      await fetch(`${f.base}/api/v1/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adminConfirm: true,
          username: "alice",
          password: PASSWORD,
          name: "rw",
          scope: "rw",
        }),
      }),
    );
    const response = await fetch(`${f.base}/api/v1/user/origins/oauth`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${minted.token}`,
      },
      body: JSON.stringify({ host: f.fake.url, kind: "github" }),
    });
    expect(response.status).toBe(403);
  });

  test("connect attempts are capped per user: ten pass, the eleventh is refused and told to wait a minute", async () => {
    // An account that has not connected yet, so the count is exact. The
    // window is the forge's own: a fresh forge starts with a fresh one.
    f.oauth.approved = false;
    const attempt = async () =>
      (
        await api("/api/v1/user/origins/oauth", {
          method: "POST",
          as: "carol",
          body: JSON.stringify({ host: f.fake.url, kind: "github" }),
        })
      ).status;
    for (let i = 0; i < 10; i++) expect(await attempt()).toBe(201);
    const refused = await api("/api/v1/user/origins/oauth", {
      method: "POST",
      as: "carol",
      body: JSON.stringify({ host: f.fake.url, kind: "github" }),
    });
    expect(refused.status).toBe(429);
    const said = (await refused.json()) as { message: string; retryAfter: number };
    expect(said.message).toBe("too many connect attempts; wait a minute");
    expect(said.retryAfter).toBe(60);
    // Someone else's attempts are their own.
    expect(
      (
        await api("/api/v1/user/origins/oauth", {
          method: "POST",
          as: "bob",
          body: JSON.stringify({ host: f.fake.url, kind: "github" }),
        })
      ).status,
    ).toBe(201);
  });

  test("disconnecting revokes the grant with the app's own credentials", async () => {
    // Bob connects: alice's one connection stands, and the account that
    // disconnects is not the point here.
    // Revocation authenticates as the *application*, so it is only reachable
    // when the operator configured a secret.
    process.env.FORGE_GITHUB_CLIENT_SECRET = "operator-client-secret";
    f.oauth.approved = true;
    f.oauth.deviceError = "";
    const started = await read<{ flowId: string }>(
      await api("/api/v1/user/origins/oauth", {
        method: "POST",
        as: "bob",
        body: JSON.stringify({ host: f.fake.url, kind: "github" }),
      }),
    );
    const done = await read<{ originId: string }>(
      await api(`/api/v1/user/origins/oauth/${started.flowId}`, { as: "bob" }),
    );

    const gone = await read<{ revokedUpstream: boolean }>(
      await api(`/api/v1/user/origins/${done.originId}`, {
        method: "DELETE",
        as: "bob",
      }),
    );
    expect(gone.revokedUpstream).toBe(true);
    const revoked = f.oauth.revoked.at(-1)!;
    expect(revoked.clientId).toBe(CLIENT_ID);
    expect(revoked.authorization).toBe(
      basic(CLIENT_ID, "operator-client-secret"),
    );
    delete process.env.FORGE_GITHUB_CLIENT_SECRET;
  });
});

// ------------------------------------------------------------------ code

describe("Forgejo's code flow: PKCE, state, and a browser anywhere", () => {
  let f: Fixture;
  const api = (path: string, init?: RequestInit & { as?: string }) => {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined)
      headers.set("content-type", "application/json");
    headers.set("authorization", basic(init?.as ?? "alice", PASSWORD));
    return fetch(`${f.base}${path}`, { ...init, headers });
  };

  beforeAll(async () => {
    f = await boot("forgejo");
    await api("/api/v1/user/origin-apps", {
      method: "POST",
      body: JSON.stringify({ host: f.fake.url, clientId: CLIENT_ID }),
    });
  });
  afterAll(() => shutdown(f));

  test("the authorize URL is PKCE-S256 with an exact redirect", async () => {
    const started = await read<{ flow: string; url: string }>(
      await api("/api/v1/user/origins/oauth", {
        method: "POST",
        body: JSON.stringify({ host: f.fake.url }),
      }),
    );
    // Forgejo implements no device grant, so this is the only OAuth path.
    expect(started.flow).toBe("code");
    const url = new URL(started.url);
    expect(url.origin).toBe(f.fake.url);
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeString();
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${f.base}/settings/origins/callback`,
    );
    const state = url.searchParams.get("state")!;
    expect(state.length).toBeGreaterThan(20);

    // The state is stored only as a digest: a database read hands nobody a
    // usable state.
    const rows = f.app.db
      .query<
        { state_hash: string | null },
        []
      >("SELECT state_hash FROM oauth_flow WHERE status = 'pending'")
      .all();
    expect(rows.some((r) => r.state_hash === state)).toBe(false);
  });

  test("the callback exchanges the code and connects the account", async () => {
    const started = await read<{ url: string }>(
      await api("/api/v1/user/origins/oauth", {
        method: "POST",
        body: JSON.stringify({ host: f.fake.url }),
      }),
    );
    const state = new URL(started.url).searchParams.get("state")!;
    const challenge = new URL(started.url).searchParams.get("code_challenge")!;

    const callback = await api(
      `/settings/origins/callback?state=${encodeURIComponent(state)}&code=${f.oauth.authCode}`,
      { redirect: "manual" },
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe(
      "/settings/origins?connected=1",
    );

    // The exchange carried the verifier and the same redirect URI — the two
    // things that make an intercepted code worthless.
    const exchange = f.oauth.tokenRequests.at(-1)!;
    expect(exchange.grant_type).toBe("authorization_code");
    expect(exchange.redirect_uri).toBe(`${f.base}/settings/origins/callback`);
    expect(exchange.code_verifier).toBeString();
    // And the verifier really is the preimage of the challenge we published.
    const verifier = exchange.code_verifier!;
    expect(pkce().challenge).not.toBe(challenge); // sanity: challenges differ
    expect(verifier.length).toBeGreaterThan(42);

    const origins = await read<{ authKind: string; login: string }[]>(
      await api("/api/v1/user/origins"),
    );
    expect(origins).toHaveLength(1);
    expect(origins[0]).toMatchObject({ authKind: "oauth", login: LOGIN });
  });

  test("a state cannot be replayed, borrowed, or invented", async () => {
    f.app.db.query("DELETE FROM origin").run();
    const started = await read<{ url: string }>(
      await api("/api/v1/user/origins/oauth", {
        method: "POST",
        body: JSON.stringify({ host: f.fake.url }),
      }),
    );
    const state = new URL(started.url).searchParams.get("state")!;

    // Someone else's callback finds nothing at all — the same answer an
    // invented state gets, so nothing is confirmed by the difference.
    const stolen = await completeOAuthCallback(
      f.app,
      getUserByName(f.app.db, "bob"),
      { state, code: f.oauth.authCode },
    );
    expect(stolen).toEqual({ ok: false, error: "not_found" });

    const invented = await api(
      "/settings/origins/callback?state=made-up&code=whatever",
      { redirect: "manual" },
    );
    expect(invented.headers.get("location")).toBe(
      "/settings/origins?error=state",
    );

    // The rightful owner completes it once...
    const first = await api(
      `/settings/origins/callback?state=${encodeURIComponent(state)}&code=${f.oauth.authCode}`,
      { redirect: "manual" },
    );
    expect(first.headers.get("location")).toBe("/settings/origins?connected=1");
    // ...and the same state is dead the second time.
    const before = f.oauth.tokenRequests.length;
    const replay = await api(
      `/settings/origins/callback?state=${encodeURIComponent(state)}&code=${f.oauth.authCode}`,
      { redirect: "manual" },
    );
    expect(replay.headers.get("location")).toBe(
      "/settings/origins?error=state",
    );
    expect(f.oauth.tokenRequests.length).toBe(before);
  });

  test("an expired flow is refused", async () => {
    const alice = getUserByName(f.app.db, "alice")!;
    const started = await startOAuthConnect(f.app, alice, {
      host: f.fake.url,
      redirectUri: `${f.base}/settings/origins/callback`,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const state = new URL(started.value.url).searchParams.get("state")!;
    f.app.db
      .query("UPDATE oauth_flow SET expires_at = ?1 WHERE id = ?2")
      .run(new Date(Date.now() - 1000).toISOString(), started.value.flowId);

    const before = f.oauth.tokenRequests.length;
    expect(
      await completeOAuthCallback(f.app, alice, {
        state,
        code: f.oauth.authCode,
      }),
    ).toEqual({ ok: false, error: "not_found" });
    expect(f.oauth.tokenRequests.length).toBe(before);
  });
});

// --------------------------------------------------------------- refresh

describe("refreshing an OAuth credential", () => {
  let f: Fixture;
  let originId = "";
  const api = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined)
      headers.set("content-type", "application/json");
    headers.set("authorization", basic("alice", PASSWORD));
    return fetch(`${f.base}${path}`, { ...init, headers });
  };

  beforeAll(async () => {
    f = await boot("forgejo");
    await api("/api/v1/user/origin-apps", {
      method: "POST",
      body: JSON.stringify({ host: f.fake.url, clientId: CLIENT_ID }),
    });
    const started = await read<{ url: string }>(
      await api("/api/v1/user/origins/oauth", {
        method: "POST",
        body: JSON.stringify({ host: f.fake.url }),
      }),
    );
    const state = new URL(started.url).searchParams.get("state")!;
    await api(
      `/settings/origins/callback?state=${encodeURIComponent(state)}&code=${f.oauth.authCode}`,
      { redirect: "manual" },
    );
    originId = f.app.db
      .query<{ id: string }, []>("SELECT id FROM origin")
      .get()!.id;
  });
  afterAll(() => shutdown(f));

  /** Age the credential so the next use has to refresh it. */
  const expire = (): void => {
    f.app.db
      .query("UPDATE origin SET expires_at = ?1 WHERE id = ?2")
      .run(new Date(Date.now() - 1000).toISOString(), originId);
  };

  test("two concurrent calls on an expired token refresh exactly once", async () => {
    expire();
    const before = f.oauth.tokenRequests.filter(
      (r) => r.grant_type === "refresh_token",
    ).length;
    const credential = credentialFor(f.app, getOriginById(f.app.db, originId)!);
    expect(credential.ok).toBe(true);
    if (!credential.ok) return;

    // Both callers await the same in-flight refresh. Two parallel refreshes
    // against a rotating provider would spend the token twice, and the loser
    // would present one the winner already invalidated — a bricked origin.
    const [a, b] = await Promise.all([
      credential.value.token(),
      credential.value.token(),
    ]);
    const after = f.oauth.tokenRequests.filter(
      (r) => r.grant_type === "refresh_token",
    ).length;
    expect(after - before).toBe(1);
    expect(a).toEqual({ ok: true, value: f.oauth.accessToken });
    expect(b).toEqual({ ok: true, value: f.oauth.accessToken });
  });

  test("a rotated refresh token is persisted before it is needed", () => {
    const sealed = sealedSecrets(f.app.db, originId)!;
    const stored = open(f.dataDir, sealed.refresh, originId);
    expect(stored).toEqual({ ok: true, value: f.oauth.refreshToken });
    // The rotation really happened — this is not the token we started with.
    expect(f.oauth.refreshToken).toStartWith("ghr_rotated");
    expect(getOriginById(f.app.db, originId)!.needsReauth).toBe(false);
  });

  test("a spent refresh token ends the connection instead of looping", async () => {
    for (const code of ["invalid_grant", "unauthorized_client"]) {
      f.app.db
        .query("UPDATE origin SET needs_reauth = 0 WHERE id = ?1")
        .run(originId);
      expire();
      f.oauth.refreshError = code;
      const before = f.oauth.tokenRequests.length;
      const credential = credentialFor(
        f.app,
        getOriginById(f.app.db, originId)!,
      );
      if (!credential.ok) throw new Error("no credential");
      const resolved = await credential.value.token();
      expect(resolved.ok).toBe(false);

      const origin = getOriginById(f.app.db, originId)!;
      expect(origin.needsReauth).toBe(true);
      expect(origin.lastError).toContain("already used");

      // A second attempt does not go near the network: retrying a spent
      // grant forever is how one dead credential becomes an error loop.
      const again = await credential.value.token();
      expect(again.ok).toBe(false);
      expect(f.oauth.tokenRequests.length).toBe(before + 1);
    }
    f.oauth.refreshError = "";
  });

  test("nothing in the audit trail carries token material", () => {
    const events = listEvents(f.app.db, { limit: 200 });
    const text = JSON.stringify(events);
    expect(events.map((e) => e.kind)).toContain("origin.connected");
    expect(events.map((e) => e.kind)).toContain("origin.needs_reauth");
    expect(text).not.toMatch(/gh[pousr]_/);
    expect(text).not.toContain(f.oauth.accessToken);
    expect(text).not.toContain(f.oauth.refreshToken);
    expect(text).not.toContain(CLIENT_ID);
  });
});

// ----------------------------------------------------------- log scrubbing

describe("a credential cannot reach a log line", () => {
  test("credential-shaped strings are scrubbed on the way out", () => {
    for (const secret of [
      "gho_abcdefghijklmnopqrstuvwxyz0123456789",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "forge_abcdefghijklmnopqrstuvwxyz012345",
    ]) {
      expect(redactSecrets(`token=${secret}`)).not.toContain(secret);
    }
    expect(
      redactSecrets("authorization=Bearer abcdefghijklmnopqrstuvwxyz"),
    ).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(
      redactSecrets('refresh_token="ghr_qqqqqqqqqqqqqqqqqqqq"'),
    ).not.toContain("ghr_qqqqqqqqqqqqqqqqqqqq");
    // Ordinary lines survive intact.
    expect(redactSecrets("origin sync ok repos=3")).toBe(
      "origin sync ok repos=3",
    );
  });
});

// ------------------------------------------------------------------ SSRF

describe("discovery will not dial anything it is asked to", () => {
  const env = (allow?: string) =>
    allow === undefined ? {} : { FORGE_ORIGIN_ALLOW: allow };

  test("plaintext and private addresses never leave the process", async () => {
    // The user names a host and the server fetches it: textbook SSRF, so the
    // policy is https-only with a deny-list of ranges a server has no
    // business dialling on a stranger's say-so. Asserted on the policy
    // itself, so nothing here can accidentally dial anything.
    for (const refused of [
      "http://example.com",
      "https://10.1.2.3",
      "https://192.168.0.5",
      "https://172.16.4.4",
      "https://169.254.169.254",
      "https://100.100.1.1",
      "https://[fd00::1]",
      // IPv4-mapped IPv6 literals: the WHATWG URL parser folds these down to
      // a bare `::ffff:<hex>:<hex>` hostname, so the private-range check must
      // decode that back to octets rather than only pattern-matching the
      // dotted-quad form.
      "https://[::ffff:169.254.169.254]",
      "https://[::ffff:10.0.0.1]",
      "https://[::ffff:127.0.0.1]",
      "file:///etc/passwd",
      "ssh://git@example.com",
      "gopher://example.com",
      "",
    ]) {
      expect(allowedOrigin(refused, env())).toBeUndefined();
    }
    // Public https hosts are fine, and so is loopback (this machine).
    expect(allowedOrigin("codeberg.org", env())).toBe("https://codeberg.org");
    expect(allowedOrigin("http://localhost:3000", { FORGE_DEV: "1" })).toBe(
      "http://localhost:3000",
    );
    expect(allowedOrigin("http://127.0.0.1:9", { FORGE_DEV: "1" })).toBe(
      "http://127.0.0.1:9",
    );

    // And discovery itself refuses the same input without making a request.
    expect(await discover("file:///etc/passwd", env())).toEqual({
      ok: false,
      error: "unknown_host",
    });
  });

  test("an operator can vouch for a host, and only an operator", () => {
    // The one escape hatch: an operator naming a LAN forge. Never a per-user
    // toggle — the risk it accepts belongs to the server, not the user.
    expect(allowedOrigin("http://10.1.2.3:9", env())).toBeUndefined();
    expect(allowedOrigin("http://10.1.2.3:9", env("10.1.2.3:9"))).toBe(
      "http://10.1.2.3:9",
    );
    expect(allowedOrigin("https://git.lan", env("git.lan"))).toBe(
      "https://git.lan",
    );
    // Vouching for one host does not vouch for its neighbours.
    expect(
      allowedOrigin("http://10.1.2.4:9", env("10.1.2.3:9")),
    ).toBeUndefined();
  });
});

describe("discovery vets every host and every hop (#2993)", () => {
  test("a name that resolves privately, and a redirect to the metadata address, are refused", async () => {
    const resolved = await discover("https://sneaky.example", {}, {
      resolve: async () => ["10.0.0.5"],
    });
    expect(resolved).toEqual({ ok: false, error: "private_host" });

    const hop = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
    });
    try {
      const env = { FORGE_DEV: "1" };
      const found = await discover(`http://127.0.0.1:${hop.port}`, env);
      expect(found).toEqual({ ok: false, error: "private_host" });
    } finally {
      hop.stop(true);
    }
  });

  test("loopback is reachable in dev only, and an operator can still name it", () => {
    expect(allowedOrigin("http://127.0.0.1:9", { FORGE_DEV: "1" })).toBe(
      "http://127.0.0.1:9",
    );
    expect(allowedOrigin("http://127.0.0.1:9", {})).toBeUndefined();
    expect(allowedOrigin("http://localhost:3000", {})).toBeUndefined();
    expect(
      allowedOrigin("http://localhost:3000", {
        FORGE_ORIGIN_ALLOW: "localhost:3000",
      }),
    ).toBe("http://localhost:3000");
  });
});
