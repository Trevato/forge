/**
 * Sign in with your forge (#748): two forges booted, a person signed into the
 * child through the parent's OpenID provider. The id_token's checks are tried
 * one spoiled claim at a time, and the parent's keys are fetched once and
 * again only for a key id they do not hold.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserByName, verifyPasswordThrottled } from "../src/core/users.ts";
import { keepClient, CALLBACK_PATH } from "../src/core/federation.ts";
import { forgeSshSession } from "../src/tui/ssh.ts";
import { addKey, findKeyByFingerprint, fingerprint, parseAuthorizedKey } from "../src/core/keys.ts";
import { KeySet } from "../src/http/jwks.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { verifyJwt } from "../src/kernel/jwt.ts";
import { LIMITS, setLimit } from "../src/settings/limits.ts";
import { notePeer } from "../src/http/peer.ts";
import { signinAllowed } from "../src/web/pages/site.ts";
import type { Ctx } from "../src/http/context.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-family-passphrase";

describe("sign in through the parent forge", () => {
  let dirs: string[] = [];
  let parent: App;
  let child: App;
  let parentServers: Servers;
  let childServers: Servers;
  let alice = "";
  let aliceCookie = "";

  const cookieOf = (res: Response, name: string): string | undefined =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .find((c) => c.startsWith(`${name}=`));

  /** Begin at the child, consent at the parent as the person with `cookie`; the child's callback address and its state cookie. */
  const begin = async (cookie: string) => {
    const start = await fetch(`${childServers.url}/signin/parent`, { redirect: "manual" });
    expect(start.status).toBe(303);
    const to = new URL(start.headers.get("location")!);
    expect(to.origin).toBe(parentServers.url);
    expect(to.pathname).toBe("/oauth/authorize");
    const state = cookieOf(start, "forge_rp")!;
    expect(state).toBeDefined();
    const consent = await fetch(`${parentServers.url}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: parentServers.url },
      body: new URLSearchParams({
        ...Object.fromEntries(to.searchParams),
        decision: "allow",
      }),
    });
    expect(consent.status).toBe(303);
    return { callback: new URL(consent.headers.get("location")!), state };
  };
  const finish = (callback: URL, state: string | undefined) =>
    fetch(`${childServers.url}${callback.pathname}${callback.search}`, {
      redirect: "manual",
      headers: state === undefined ? {} : { cookie: state },
    });

  beforeAll(async () => {
    const make = async () => {
      const dir = await mkdtemp(join(tmpdir(), "forge-signin-"));
      dirs.push(dir);
      return dir;
    };
    parent = createApp({ dataDir: await make(), port: 0 });
    parentServers = await serve(parent);
    child = createApp({
      dataDir: await make(),
      port: 0,
      parentUrl: parentServers.url,
      parentLoopback: true,
    });
    childServers = await serve(child);
    const made = await createUser(parent.db, {
      origin: "seed",
      username: "alice",
      email: "alice@parent.local",
      password: PASSWORD,
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value.id;
    aliceCookie = `forge_session=${createSession(parent.db, alice).token}`;
  });
  afterAll(async () => {
    parentServers.stop();
    childServers.stop();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  test("only a forge with a parent offers the button", async () => {
    const onChild = await (await fetch(`${childServers.url}/signin`)).text();
    expect(onChild).toContain(`Continue with ${new URL(parentServers.url).host}`);
    expect(onChild).toContain('href="/signin/parent"');
    expect(await (await fetch(`${parentServers.url}/signin`)).text()).not.toContain("Continue with");
    const none = await fetch(`${parentServers.url}/signin/parent`, { redirect: "manual" });
    expect(none.status).toBe(404);
  });

  test("a person signs into the child through the parent, and the account keys on sub", async () => {
    const { callback, state } = await begin(aliceCookie);
    expect(callback.origin).toBe(childServers.url);
    const done = await finish(callback, state);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/");
    const session = cookieOf(done, "forge_session")!;
    expect(session).toBeDefined();
    expect(done.headers.getSetCookie().find((c) => c.startsWith("forge_session="))).toContain("HttpOnly");

    const local = getUserByName(child.db, "alice")!;
    expect(local.id).not.toBe("");
    // No password was ever set: only the parent vouches for this account.
    expect((await verifyPasswordThrottled(child.db, { username: "alice", password: "", source: "127.0.0.1" })).ok).toBe(false);
    expect((await verifyPasswordThrottled(child.db, { username: "alice", password: PASSWORD, source: "127.0.0.1" })).ok).toBe(false);
    const settings = await fetch(`${childServers.url}/settings`, { headers: { cookie: session }, redirect: "manual" });
    expect(settings.status).toBe(200);

    // Renamed at the parent, the same person is the same local account.
    parent.db.query("UPDATE user SET username = 'alice-renamed' WHERE id = ?1").run(alice);
    const again = await begin(aliceCookie);
    const second = await finish(again.callback, again.state);
    expect(second.status).toBe(303);
    expect(getUserByName(child.db, "alice-renamed")).toBeUndefined();
    expect(child.db.query("SELECT COUNT(*) AS n FROM user WHERE username LIKE 'alice%'").get()).toEqual({ n: 1 });
    // Registered at the parent once, and the id kept.
    expect(parent.db.query("SELECT COUNT(*) AS n FROM oauth_client").get()).toEqual({ n: 1 });
    expect(child.db.query("SELECT COUNT(*) AS n FROM rp_client").get()).toEqual({ n: 1 });
    parent.db.query("UPDATE user SET username = 'alice' WHERE id = ?1").run(alice);
  });

  test("signing in leaves no API credential at the parent, and the token answer carries none", async () => {
    const tokens = () => parent.db.query("SELECT COUNT(*) AS n FROM token WHERE user_id = ?1").get(alice);
    const before = tokens();
    const page = await fetch(
      `${parentServers.url}/oauth/authorize?` +
        new URL((await fetch(`${childServers.url}/signin/parent`, { redirect: "manual" })).headers.get("location")!).searchParams,
      { headers: { cookie: aliceCookie } },
    );
    const text = await page.text();
    expect(text).toContain("Sign in");
    expect(text).not.toContain('name="lifetime"');
    expect(text).not.toContain('name="grant"');
    const { callback, state } = await begin(aliceCookie);
    expect((await finish(callback, state)).status).toBe(303);
    expect(tokens()).toEqual(before);

    // The exchange itself, done by hand: an id_token and nothing to call the API with.
    const client = parent.db
      .query<{ id: string; redirect_uris: string }, []>("SELECT id, redirect_uris FROM oauth_client")
      .get()!;
    const redirect = (JSON.parse(client.redirect_uris) as string[])[0]!;
    const verifier = "v".repeat(64);
    const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
    const asked = await fetch(`${parentServers.url}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: aliceCookie, origin: parentServers.url },
      body: new URLSearchParams({
        response_type: "code",
        client_id: client.id,
        redirect_uri: redirect,
        scope: "openid profile",
        state: "s",
        nonce: "n",
        code_challenge: challenge,
        code_challenge_method: "S256",
        decision: "allow",
      }),
    });
    const code = new URL(asked.headers.get("location")!).searchParams.get("code")!;
    const answer = await fetch(`${parentServers.url}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: client.id,
        redirect_uri: redirect,
        code_verifier: verifier,
      }),
    });
    const body = (await answer.json()) as Record<string, unknown>;
    expect(answer.status).toBe(200);
    expect(typeof body.id_token).toBe("string");
    expect(body.access_token).toBeUndefined();
    expect(tokens()).toEqual(before);
  });

  test("a parent's name that is taken here does not take over the local account", async () => {
    const bob = await createUser(parent.db, { origin: "seed", username: "bob", email: "bob@parent.local", password: PASSWORD });
    if (!bob.ok) throw new Error(bob.error);
    const local = await createUser(child.db, { origin: "seed", username: "bob", email: "bob@child.local", password: PASSWORD });
    if (!local.ok) throw new Error(local.error);
    const { callback, state } = await begin(`forge_session=${createSession(parent.db, bob.value.id).token}`);
    const done = await finish(callback, state);
    expect(done.status).toBe(303);
    const row = child.db
      .query<{ user_id: string }, [string]>("SELECT user_id FROM federated_identity WHERE sub = ?1")
      .get(bob.value.id)!;
    expect(row.user_id).not.toBe(local.value.id);
  });

  test("a callback is refused without its browser's cookie, with another state, or a second time", async () => {
    const { callback, state } = await begin(aliceCookie);
    expect((await finish(callback, undefined)).status).toBe(400);
    expect((await finish(callback, "forge_rp=other")).status).toBe(400);
    const sessions = () => child.db.query("SELECT COUNT(*) AS n FROM session").get();
    const before = sessions();
    expect((await finish(callback, state)).status).toBe(303);
    const replay = await finish(callback, state);
    expect(replay.status).toBe(400);
    expect(cookieOf(replay, "forge_session")).toBeUndefined();
    expect(sessions()).toEqual({ n: (before as { n: number }).n + 1 });
  });

  test("a nonce that is not the one this browser sent is refused", async () => {
    const { callback, state } = await begin(aliceCookie);
    child.db.query("UPDATE rp_login SET nonce = 'not-the-nonce'").run();
    const done = await finish(callback, state);
    expect(done.status).toBe(502);
    expect(cookieOf(done, "forge_session")).toBeUndefined();
  });

  test("an error from the parent, or no code, signs no one in", async () => {
    const { state } = await begin(aliceCookie);
    const value = state.slice("forge_rp=".length);
    const done = await finish(new URL(`${childServers.url}/signin/parent/callback?state=${value}&error=access_denied`), state);
    expect(done.status).toBe(400);
    expect(cookieOf(done, "forge_session")).toBeUndefined();
  });
  test("a person made here adds an SSH key, and the terminal's key door resolves it to that account", async () => {
    const local = getUserByName(child.db, "alice")!;
    const line = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2S7bF0R4NmuTUvVJXPPjdI1AF8XHXeYSNfr8DJ5eDo alice";
    const parsed = parseAuthorizedKey(line);
    if (!parsed.ok) throw new Error("key");
    expect(addKey(child.db, local.id, "laptop", parsed.value).ok).toBe(true);
    expect(findKeyByFingerprint(child.db, fingerprint(parsed.value.blob))?.userId).toBe(local.id);

    // And the terminal itself: a shell opened with that key is that account's.
    let screen = "";
    const closers: (() => void)[] = [];
    const session = {
      key: { fingerprint: fingerprint(parsed.value.blob), line },
      username: "whoever",
      remoteAddress: "203.0.113.9",
      kind: "shell" as const,
      command: undefined,
      term: "xterm-256color",
      env: {},
      cols: 100,
      rows: 30,
      widthPx: 0,
      heightPx: 0,
      ended: false,
      pending: 0,
      write(data: Uint8Array | string) {
        screen += typeof data === "string" ? data : Buffer.from(data).toString();
      },
      writeStderr() {},
      onData() {},
      onResize() {},
      onEof() {},
      onClose(cb: () => void) {
        closers.push(cb);
      },
      exit() {
        for (const cb of closers) cb();
      },
      drained: async () => {},
    };
    forgeSshSession(child)(session as never);
    await Bun.sleep(300);
    session.exit();
    expect(screen).toContain("alice");
  });

  test("starting a sign-in is throttled, so a flood cannot push out those in flight", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++)
      statuses.push((await fetch(`${childServers.url}/signin/parent`, { redirect: "manual" })).status);
    expect(statuses).toContain(429);
    const slow = await fetch(`${childServers.url}/signin/parent`, { redirect: "manual" });
    expect(slow.status).toBe(429);
    expect(Number(slow.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("the sign-in throttle", () => {
  test("a key that is refused does not spend the forge-wide budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-signin-"));
    const app = createApp({ dataDir: dir, port: 0 });
    const from = (address: string): Ctx => {
      const request = new Request("http://forge.test/");
      notePeer(request, address);
      return { app, request } as unknown as Ctx;
    };
    for (let i = 0; i < 60; i++) signinAllowed(from("10.0.0.1"), "parent:one");
    // The forge's whole budget (200) is still there for 180 other keys.
    for (let i = 0; i < 180; i++) expect(signinAllowed(from(`10.1.${i}.1`), `k${i}`)).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("verifyJwt", () => {
  const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
  let pair: CryptoKeyPair;
  let jwk: Record<string, unknown>;
  const now = 1_700_000_000_000;
  const expectation = { issuer: "https://p", audience: "c1", nonce: "n1" };

  beforeAll(async () => {
    pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
  });
  const mint = async (claims: Record<string, unknown> = {}, head: Record<string, unknown> = {}) => {
    const h = b64({ alg: "ES256", kid: "k1", ...head });
    const p = b64({ iss: "https://p", aud: "c1", nonce: "n1", sub: "s", exp: now / 1000 + 60, ...claims });
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
  };
  const keys = async (kid: string) => (kid === "k1" ? jwk : undefined);

  test("a good token passes", async () => {
    const out = await verifyJwt(await mint(), keys, expectation, now);
    expect(out.ok && out.value["sub"]).toBe("s");
  });

  test("each spoiled claim, key and signature is refused", async () => {
    const good = await mint();
    const [h, p, s] = good.split(".");
    const forged = `${h}.${b64({ iss: "https://p", aud: "c1", nonce: "n1", sub: "root", exp: now / 1000 + 60 })}.${s}`;
    const cases: [string, string][] = [
      ["wrong iss", await mint({ iss: "https://evil" })],
      ["wrong aud", await mint({ aud: "c2" })],
      ["wrong nonce", await mint({ nonce: "n2" })],
      ["no nonce", await mint({ nonce: undefined })],
      ["expired", await mint({ exp: now / 1000 - 1 })],
      ["no exp", await mint({ exp: undefined })],
      ["unknown kid", await mint({}, { kid: "k2" })],
      ["alg none", await mint({}, { alg: "none" })],
      ["alg HS256", await mint({}, { alg: "HS256" })],
      ["tampered payload", forged],
      ["two parts", `${h}.${p}`],
      ["not base64", "a.b.c!"],
    ];
    for (const [name, jwt] of cases) {
      const out = await verifyJwt(jwt, keys, expectation, now);
      expect([name, out.ok]).toEqual([name, false]);
    }
    // A key that is not the signer's refuses a good token.
    const other = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const otherJwk = { ...(await crypto.subtle.exportKey("jwk", other.publicKey)), kid: "k1" };
    expect((await verifyJwt(good, async () => otherJwk, expectation, now)).ok).toBe(false);
  });
});

describe("a parent's keys, cached", () => {
  const set = (keys: string[]) => {
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      return Response.json({ keys: keys.map((kid) => ({ kid, kty: "EC" })) });
    };
    return { calls, fetcher };
  };

  test("fetched once, then served from memory", async () => {
    const { calls, fetcher } = set(["a", "b"]);
    const keys = new KeySet("https://p/oauth/jwks", fetcher);
    expect((await keys.find("a", 1000))?.["kid"]).toBe("a");
    expect((await keys.find("b", 2000))?.["kid"]).toBe("b");
    expect((await keys.find("a", 3000))?.["kid"]).toBe("a");
    expect(calls).toHaveLength(1);
  });

  test("an unknown kid looks again once, and not again within the minute", async () => {
    const live = set(["a"]);
    const keys = new KeySet("https://p/oauth/jwks", live.fetcher);
    await keys.find("a", 0);
    // The parent rotated: the next fetch has the new key.
    const rotated = set(["a", "b"]);
    (keys as unknown as { fetcher: unknown }).fetcher = rotated.fetcher;
    expect(await keys.find("b", 70_000)).toBeDefined();
    expect(rotated.calls).toHaveLength(1);
    // A kid nobody has: one more look at most, then none for a minute.
    expect(await keys.find("zzz", 140_000)).toBeUndefined();
    expect(await keys.find("zzz", 141_000)).toBeUndefined();
    expect(await keys.find("yyy", 150_000)).toBeUndefined();
    expect(rotated.calls).toHaveLength(2);
  });

  test("an unreachable parent keeps the keys it had", async () => {
    const good = set(["a"]);
    const keys = new KeySet("https://p/oauth/jwks", good.fetcher);
    await keys.find("a", 0);
    (keys as unknown as { fetcher: unknown }).fetcher = async () => {
      throw new Error("down");
    };
    expect(await keys.find("nope", 100_000)).toBeUndefined();
    expect(await keys.find("a", 100_001)).toBeDefined();
  });
});

describe("a parent's oversized answer", () => {
  /** A body that never ends, counting how many chunks were pulled from it. */
  const endless = () => {
    const pulled = { n: 0 };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled.n++;
        controller.enqueue(new Uint8Array(1024).fill(32));
      },
    });
    return { pulled, response: new Response(body) };
  };

  test("the key set is refused past its cap without reading on", async () => {
    const { pulled, response } = endless();
    const keys = new KeySet("https://p/oauth/jwks", async () => response);
    expect(await keys.find("a", 0)).toBeUndefined();
    expect(pulled.n).toBeLessThan(200);
  });
});

describe("a parent's oversized register and token answers", () => {
  const realFetch = globalThis.fetch;
  const PARENT = "http://parent.invalid";
  let dir = "";
  let child: App;
  let servers: Servers;
  let pulled = { n: 0 };
  let streaming: "register" | "token" | "" = "";

  /** A body that never ends, counting how many chunks were pulled from it. */
  const endless = (): Response => {
    pulled = { n: 0 };
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled.n++;
          controller.enqueue(new Uint8Array(1024).fill(32));
        },
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-signin-"));
    // The parent is this stub; every other address is reached as usual.
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${PARENT}/oauth/register` && streaming === "register") return Promise.resolve(endless());
      if (url === `${PARENT}/oauth/token` && streaming === "token") return Promise.resolve(endless());
      return realFetch(input, init);
    }) as typeof fetch;
    child = createApp({ dataDir: dir, port: 0, parentUrl: PARENT, parentLoopback: true });
    servers = await serve(child);
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    servers.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("a registration that streams forever is a 502, and few chunks are pulled", async () => {
    streaming = "register";
    const res = await fetch(`${servers.url}/signin/parent`, { redirect: "manual" });
    expect(res.status).toBe(502);
    expect(pulled.n).toBeGreaterThan(0);
    expect(pulled.n).toBeLessThan(100);
    expect(child.db.query("SELECT COUNT(*) AS n FROM rp_client").get()).toEqual({ n: 0 });
  });

  test("a token answer that streams forever is a 502 with no session, and few chunks are pulled", async () => {
    streaming = "";
    keepClient(child.db, `${PARENT}`, `${servers.url}${CALLBACK_PATH}`, "client-1");
    const start = await fetch(`${servers.url}/signin/parent`, { redirect: "manual" });
    expect(start.status).toBe(303);
    const cookie = start.headers.getSetCookie()[0]!.split(";")[0]!;
    const state = cookie.slice("forge_rp=".length);
    streaming = "token";
    const res = await fetch(`${servers.url}${CALLBACK_PATH}?code=abc&state=${state}`, {
      redirect: "manual",
      headers: { cookie },
    });
    expect(res.status).toBe(502);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("forge_session=") && !c.includes("Max-Age=0"))).toBe(false);
    expect(pulled.n).toBeGreaterThan(0);
    expect(pulled.n).toBeLessThan(100);
  });
});

describe("the per-source sign-in window", () => {
  test("one source trying many accounts is throttled while another is not, and the limit is listed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-signin-source-"));
    const app = createApp({ dataDir: dir, port: 0 });
    const from = (address: string, headers: Record<string, string> = {}): Ctx => {
      const request = new Request("http://forge.test/", { headers });
      notePeer(request, address);
      return { app, request } as unknown as Ctx;
    };
    expect(LIMITS["signin.per_source"].default).toBe(60);
    setLimit(app.db, "signin.per_source", 5, "setup");
    for (let i = 0; i < 5; i++) expect(signinAllowed(from("192.0.2.1"), `acct${i}`)).toBeUndefined();
    // A sixth account from the same source is refused, even with a spoofed header.
    const wait = signinAllowed(from("192.0.2.1", { "x-forwarded-for": "198.51.100.9" }), "acct5");
    expect(wait).toBeGreaterThan(0);
    // A different source is not throttled at the same moment.
    expect(signinAllowed(from("192.0.2.2"), "acct6")).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });
});
