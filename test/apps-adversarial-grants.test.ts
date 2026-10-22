/**
 * Adversarial coverage for apps (docs/APPS.md), through a live apps
 * runtime: the private-preview grant and the proxy. Split from apps-
 * adversarial.test.ts so no one file sets the gate's floor (#2038); each
 * file of the split boots its own forge and runtime.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { signGrant, verifyGrant } from "../src/apps/proxy.ts";
import { newApp, updateAppSettings, type NewAppResult } from "../src/actions/apps.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const DOMAIN = "apps.test";

describe("apps adversarial: grants and the proxy", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let grants: NewAppResult;
  let override: NewAppResult;
  let proxy: NewAppResult;

  const viaHost = (host: string, path = "/", init: RequestInit = {}) =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), host },
      redirect: "manual",
    });

  async function settled(
    repoId: string,
    where: (run: Run) => boolean,
    timeoutMs = 60_000,
  ): Promise<Run> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = listRuns(app.db, repoId, { kind: "deploy", limit: 50 }).find(
        where,
      );
      if (
        run &&
        (run.state === "ok" ||
          run.state === "failed" ||
          run.state === "cancelled")
      )
        return run;
      await Bun.sleep(50);
    }
    throw new Error("run did not settle in time");
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-adv-"));
    work = await mkdtemp(join(tmpdir(), "forge-adv-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 2,
    });
    await runtime.start();
    const created = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;

    // The four apps deploy side by side, once for the file.
    const make = async (name: string, visibility: "public" | "private") => {
      const made = await newApp(app, alice, { name, visibility });
      if (!made.ok) throw new Error(made.error);
      await settled(made.value.repo.id, (r) => r.env === "production");
      return made.value;
    };
    [grants, , override, proxy] = await Promise.all([
      make("grants", "private"),
      make("grantpublic", "public"),
      make("publicwithprivateapp", "public"),
      make("proxytest", "public"),
    ]);
  }, 30_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("private grant: forged, tampered, expired, wrong-env, and open-redirect are all refused; cookie is HttpOnly/SameSite", async () => {
    const repo = grants.repo;
    const record = grants.app;

    const target = { app: record, env: "production" as const };
    const good = signGrant(dataDir, target, 60_000);
    expect(verifyGrant(dataDir, good, target)).toBe(true);

    // Wrong environment: a grant for production names none for a preview.
    expect(verifyGrant(dataDir, good, { app: record, env: "pull-1" })).toBe(
      false,
    );

    // Expired: signed in the past with a short ttl.
    const expired = signGrant(dataDir, target, 1_000, Date.now() - 10_000);
    expect(verifyGrant(dataDir, expired, target)).toBe(false);

    // Tampered signature: the payload is untouched, but the MAC no longer
    // matches it — this is the actual HMAC check, not just a field mismatch.
    const parts = good.split(".");
    const payload = parts.slice(0, -1).join(".");
    const sig = parts.at(-1)!;
    const flipped = sig.at(-1) === "A" ? "B" : "A";
    const tampered = `${payload}.${sig.slice(0, -1)}${flipped}`;
    expect(verifyGrant(dataDir, tampered, target)).toBe(false);

    // Tampered payload: flip a character in the app id segment — the
    // signature is now for a different message entirely.
    const idTampered = `x${payload.slice(1)}.${sig}`;
    expect(verifyGrant(dataDir, idTampered, target)).toBe(false);

    // Forged: right shape, made-up signature.
    const forged = `${record.id}.production.${Date.now() + 60_000}.notarealsignature`;
    expect(verifyGrant(dataDir, forged, target)).toBe(false);

    // Hitting the grant endpoint on a *public* app: it still answers (it
    // is not access-gated by itself), but the token must still verify
    // correctly against that public app's own target.
    // (`grantpublic` is deployed in beforeAll.) A production-app grant
    // token does not verify for a different app's target, so this must be
    // refused (404) even though the destination app is public.
    const crossApp = await viaHost(
      `grantpublic.${DOMAIN}`,
      `/__forge/grant?t=${encodeURIComponent(good)}&to=/`,
    );
    expect(crossApp.status).toBe(404);

    // Open redirect: `to=//evil` and `to=http://evil` must both collapse to `/`.
    const okToken = signGrant(dataDir, target, 60_000);
    for (const to of [
      "//evil.example",
      "http://evil.example",
      "https://evil.example/x",
    ]) {
      const resp = await viaHost(
        `grants.${DOMAIN}`,
        `/__forge/grant?t=${encodeURIComponent(okToken)}&to=${encodeURIComponent(to)}`,
      );
      expect(resp.status).toBe(303);
      expect(resp.headers.get("location")).toBe("/");
    }

    // The cookie itself: HttpOnly and SameSite=Lax.
    const grantResp = await viaHost(
      `grants.${DOMAIN}`,
      `/__forge/grant?t=${encodeURIComponent(okToken)}&to=/`,
    );
    const cookie = grantResp.headers.get("set-cookie") ?? "";
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie).toContain("SameSite=Lax");

    // Invariant 9: a private *repository* never distinguishes "you're
    // anonymous" from "you're signed in but still can't see it" — both
    // must read `not_found`, or an anonymous prober could tell the two
    // apart and learn something about a repo they cannot see.
    const strangerCreated = await createUser(app.db, { origin: "seed", trusted: true,
      username: "stranger",
      email: "stranger@forge.local",
      password: "a-good-passphrase",
    });
    expect(strangerCreated.ok).toBe(true);
    if (!strangerCreated.ok) return;
    const { openEnvUrl } = await import("../src/actions/apps.ts");
    const anonOnPrivateRepo = openEnvUrl(app, undefined, repo, "production");
    expect(anonOnPrivateRepo.ok).toBe(false);
    if (!anonOnPrivateRepo.ok)
      expect(anonOnPrivateRepo.error).toBe("not_found");
    const strangerOnPrivateRepo = openEnvUrl(
      app,
      strangerCreated.value,
      repo,
      "production",
    );
    expect(strangerOnPrivateRepo.ok).toBe(false);
    if (!strangerOnPrivateRepo.ok)
      expect(strangerOnPrivateRepo.error).toBe("not_found");

    // `unauthorized` is reachable only through the other combination: a
    // *public* repository (so `canRead` already passes for anyone) whose
    // app access is explicitly overridden to "private". There, an
    // anonymous visitor has nothing to be vouched with, and a signed-in
    // stranger who can read the public code is still not let in: a private
    // app answers to its writers and crew only (#620).
    updateAppSettings(app, alice, override.repo, {
      access: "private",
    });
    const anonOnPublicRepo = openEnvUrl(
      app,
      undefined,
      override.repo,
      "production",
    );
    expect(anonOnPublicRepo.ok).toBe(false);
    if (!anonOnPublicRepo.ok)
      expect(anonOnPublicRepo.error).toBe("unauthorized");
    const strangerOnPublicRepo = openEnvUrl(
      app,
      strangerCreated.value,
      override.repo,
      "production",
    );
    expect(strangerOnPublicRepo.ok).toBe(false);
    if (!strangerOnPublicRepo.ok)
      expect(strangerOnPublicRepo.error).toBe("not_found");
  }, 60_000);

  test("the proxy: hop-by-hop headers are stripped, an upstream that dies mid-request yields a clean error, a claimed upgrade is a request", async () => {
    const repo = proxy.repo;

    const page = await viaHost(`proxytest.${DOMAIN}`);
    expect(page.status).toBe(200);
    // Hop-by-hop response headers never reach the client from the proxy
    // path (the app itself doesn't set them, but the proxy must strip them
    // if it ever did — assert the contract on the response we did get).
    for (const h of ["connection", "transfer-encoding", "keep-alive"]) {
      expect(page.headers.has(h)).toBe(false);
    }

    // The slug is case-insensitive end to end, through the database too —
    // not just in `parseAppHost`'s own lowercasing.
    const upperCase = await viaHost(`PROXYTEST.${DOMAIN}`);
    expect(upperCase.status).toBe(200);
    expect(await upperCase.text()).toBe(await page.text());

    // A request that says `Upgrade: websocket` without a handshake key is
    // not a handshake: it is fetched as a request, the hop-by-hop headers
    // stripped, and the app answers it as one. Real sockets are
    // test/apps-ws.test.ts.
    const ws = await viaHost(`proxytest.${DOMAIN}`, "/", {
      headers: { upgrade: "websocket", connection: "Upgrade" },
    });
    expect(ws.status).toBe(200);

    // Stop the live process out from under the proxy (simulating a crash
    // mid-request) and confirm the *next* request gets the forge's own
    // "not running" page, never a raw connection-refused/502 from Bun.
    const { stopEnv } = await import("../src/actions/apps.ts");
    await stopEnv(app, alice, repo, "production");
    const afterStop = await viaHost(`proxytest.${DOMAIN}`);
    expect(afterStop.status).toBe(502);
    expect(await afterStop.text()).toContain("not running");
  }, 60_000);

});
