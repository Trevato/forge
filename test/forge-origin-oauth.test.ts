import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { completeOAuthCallback, startOAuthConnect } from "../src/actions/origins.ts";
import { createSession } from "../src/core/sessions.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { appFor, endpoints, getFlowFor, isTerminal, refresh, registerClient, scopesFor } from "../src/origins/oauth.ts";
import { getOriginById, sealedSecrets, storeRefreshed } from "../src/core/origins.ts";
import { credentialFor } from "../src/origins/credential.ts";
import { syncsSettled } from "../src/origins/sync.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { proveAll } from "./helpers/verified.ts";

/**
 * Sign in to another forge in one click (#8902): two real forges. This one
 * registers itself at the friend's, sends the browser to its approval page
 * asking for `ro` only, and comes back with a token that refreshes.
 */

setDefaultTimeout(60_000);

describe("a forge signs in to another forge through OAuth", () => {
  const dirs: string[] = [];
  let mine: App;
  let friend: App;
  let mineServers: Servers;
  let friendServers: Servers;
  let cookie = "";
  let originId = "";

  beforeAll(async () => {
    const make = async () => {
      const dir = await mkdtemp(join(tmpdir(), "forge-forge-oauth-"));
      dirs.push(dir);
      return dir;
    };
    friend = createApp({ dataDir: await make(), port: 0 });
    friendServers = await serve(friend);
    await seedAdmin(friend, { username: "bob", email: "bob@friend.test", password: "bob-login-secret" });
    proveAll(friend);
    cookie = `forge_session=${createSession(friend.db, getUserByName(friend.db, "bob")!.id).token}`;
    mine = createApp({ dataDir: await make(), port: 0 });
    mineServers = await serve(mine);
    await seedAdmin(mine, { username: "alice", email: "alice@forge.test", password: "alice-login-secret" });
    proveAll(mine);
  }, 120_000);

  afterAll(async () => {
    await syncsSettled();
    mineServers.stop();
    friendServers.stop();
    mine.close();
    friend.close();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }, 120_000);

  test("the scope asked is ro, and the endpoints are the forge's own", () => {
    expect(scopesFor("gitea", "oauth", "forge")).toBe("ro");
    expect(scopesFor("gitea")).toContain("write:repository");
    const app = { kind: "gitea" as const, apiUrl: "", webUrl: "https://f.test/", clientId: "c", clientSecret: "" };
    expect(endpoints({ ...app, software: "forge" }).authorize).toBe("https://f.test/oauth/authorize");
    expect(endpoints(app).authorize).toBe("https://f.test/login/oauth/authorize");
  });

  test("one click: register, approve on the friend's forge, come back connected", async () => {
    const alice = getUserByName(mine.db, "alice")!;
    const redirectUri = `${mineServers.url}/settings/origins/callback`;
    const started = await startOAuthConnect(mine, alice, { host: friendServers.url, redirectUri });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.flow).toBe("code");

    // The approval page names the requester and offers ro as asked.
    const url = new URL(started.value.url);
    expect(url.origin).toBe(friendServers.url);
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe("ro");
    const page = await fetch(url, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/value="ro"\s+checked/);

    // Bob approves; the browser would follow this redirect back to us.
    const consent = await fetch(`${friendServers.url}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: friendServers.url },
      body: new URLSearchParams({
        ...Object.fromEntries(url.searchParams),
        decision: "allow",
        grant: "ro",
        name: "alice's forge",
        lifetime: "month",
      }),
    });
    const back = new URL(consent.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(redirectUri);

    const done = await completeOAuthCallback(mine, alice, {
      state: back.searchParams.get("state")!,
      code: back.searchParams.get("code")!,
    });
    expect(done.ok && done.value.status).toBe("done");
    originId = done.ok ? done.value.originId ?? "" : "";
    const origin = getOriginById(mine.db, originId)!;
    expect(origin).toMatchObject({ login: "bob", authKind: "oauth", software: "forge", needsReauth: false });
    // The registration is kept, so the next connect needs no registering.
    const kept = appFor(mine.db, mine.config.dataDir, alice.id, origin);
    expect(kept.ok).toBe(true);

    const listed = await fetch(`${mineServers.url}/api/v1/user/origins/${originId}/repos`, {
      headers: { authorization: `Basic ${Buffer.from("alice:alice-login-secret").toString("base64")}` },
    });
    expect(listed.status).toBe(200);
  });

  test("a second connect reuses the registration instead of making another", async () => {
    const before = friend.db.query<{ n: number }, []>("SELECT count(*) AS n FROM oauth_client").get()!.n;
    const alice = getUserByName(mine.db, "alice")!;
    const again = await startOAuthConnect(mine, alice, {
      host: friendServers.url,
      redirectUri: `${mineServers.url}/settings/origins/callback`,
    });
    expect(again.ok).toBe(true);
    const after = friend.db.query<{ n: number }, []>("SELECT count(*) AS n FROM oauth_client").get()!.n;
    expect(after).toBe(before);
  });

  test("refresh rotates; a spent refresh token is terminal, so needs-reauth applies", async () => {
    const alice = getUserByName(mine.db, "alice")!;
    const origin = getOriginById(mine.db, originId)!;
    const registration = appFor(mine.db, mine.config.dataDir, alice.id, origin);
    expect(registration.ok).toBe(true);
    if (!registration.ok) return;
    const { open } = await import("../src/kernel/secret.ts");
    const { sealedSecrets } = await import("../src/core/origins.ts");
    const sealed = sealedSecrets(mine.db, originId)!;
    const first = open(mine.config.dataDir, sealed.refresh, originId);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const next = await refresh(registration.value, first.value);
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.value.refreshToken).not.toBe(first.value);
    // Keep the live pair, already expired, for the credential path below.
    if (next.ok)
      storeRefreshed(mine.db, mine.config.dataDir, originId, {
        token: next.value.accessToken,
        refresh: next.value.refreshToken,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
  });

  test("the credential path refreshes a forge origin's expired token, and a spent one needs reauth", async () => {
    const { open } = await import("../src/kernel/secret.ts");
    const origin = getOriginById(mine.db, originId)!;
    const before = open(mine.config.dataDir, sealedSecrets(mine.db, originId)!.refresh, originId);
    const credential = credentialFor(mine, origin);
    expect(credential.ok).toBe(true);
    if (!credential.ok || !before.ok) return;
    expect(credential.value.software).toBe("forge");

    const token = await credential.value.token();
    expect(token.ok).toBe(true);
    const after = open(mine.config.dataDir, sealedSecrets(mine.db, originId)!.refresh, originId);
    expect(after.ok && after.value).not.toBe(before.value);
    const renewed = getOriginById(mine.db, originId)!;
    expect(Date.parse(renewed.expiresAt ?? "")).toBeGreaterThan(Date.now());
    expect(renewed.needsReauth).toBe(false);
    // It is the friend's own forge that answered: the token works there.
    if (token.ok) {
      const who = await fetch(`${friendServers.url}/api/v1/user`, { headers: { authorization: `Bearer ${token.value}` } });
      expect(who.status).toBe(200);
    }

    // The refresh token just spent is terminal, direct or through the credential path.
    const spent = before.value;
    const app = appFor(mine.db, mine.config.dataDir, origin.userId, origin);
    if (!app.ok) throw new Error("no registration");
    const replay = await refresh(app.value, spent);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(isTerminal(replay.error.error)).toBe(true);
    storeRefreshed(mine.db, mine.config.dataDir, originId, {
      token: "stale",
      refresh: spent,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const again = credentialFor(mine, getOriginById(mine.db, originId)!);
    if (!again.ok) throw new Error("no credential");
    const dead = await again.value.token();
    expect(dead.ok).toBe(false);
    expect(getOriginById(mine.db, originId)!.needsReauth).toBe(true);
  });

  test("the callback uses the software the connect began with, not a second look", async () => {
    const alice = getUserByName(mine.db, "alice")!;
    const redirectUri = `${mineServers.url}/settings/origins/callback`;
    const started = await startOAuthConnect(mine, alice, { host: friendServers.url, redirectUri });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const flow = getFlowFor(mine.db, alice.id, started.value.flowId)!;
    expect(flow.software).toBe("forge");
  });

  describe("a forge that refuses to register is told so, in words", () => {
    const serveOnce = (status: number, body: string) =>
      Bun.serve({ port: 0, fetch: () => new Response(body, { status, headers: { "content-type": "application/json" } }) });
    const ask = (url: string) => registerClient(url, { redirectUri: "https://me.test/cb", name: "x" });

    test("a bad redirect uri", async () => {
      const refused = await registerClient(friendServers.url, { redirectUri: "javascript:alert(1)", name: "x" });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.message).toContain("refused");
    });

    test("a non-2xx answer", async () => {
      const server = serveOnce(500, "{}");
      try {
        const refused = await ask(`http://127.0.0.1:${server.port}`);
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.error.message).toContain("refused");
      } finally {
        server.stop(true);
      }
    });

    test("an answer with no client_id", async () => {
      const server = serveOnce(201, "{}");
      try {
        const refused = await ask(`http://127.0.0.1:${server.port}`);
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.error.message).toContain("no client id");
      } finally {
        server.stop(true);
      }
    });

    test("a body streamed past the cap is cut off, not buffered", async () => {
      // A body that never ends: reading it whole would never return.
      const server = Bun.serve({
        port: 0,
        fetch: () =>
          new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue(new Uint8Array(16 * 1024));
                await Bun.sleep(1);
              },
            }),
            { status: 201 },
          ),
      });
      try {
        const refused = await ask(`http://127.0.0.1:${server.port}`);
        expect(refused.ok).toBe(false);
        if (!refused.ok) expect(refused.error.message).toContain("too large");
      } finally {
        server.stop(true);
      }
    });
  });
});
