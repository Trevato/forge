/**
 * Passkeys end to end: add two, remove one, sign in with the other (same
 * HttpOnly session cookie as a password), and the removed one is refused.
 * The software authenticator signs like a browser's.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { b64u } from "../src/auth/webauthn.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setLimit } from "../src/settings/limits.ts";

const te = new TextEncoder();
const sha = async (d: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest("SHA-256", d));
const cat = (...p: Uint8Array[]): Uint8Array<ArrayBuffer> => { const o: Uint8Array<ArrayBuffer> = new Uint8Array(p.reduce((n, a) => n + a.length, 0)); let i = 0; for (const a of p) { o.set(a, i); i += a.length; } return o; };
function head(major: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 256) return Uint8Array.of((major << 5) | 24, n);
  return Uint8Array.of((major << 5) | 25, n >> 8, n & 255);
}
type V = number | string | Uint8Array | [V, V][];
function enc(v: V): Uint8Array {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") { const b = te.encode(v); return cat(head(3, b.length), b); }
  if (v instanceof Uint8Array) return cat(head(2, v.length), v);
  return cat(head(5, v.length), ...v.flatMap(([k, x]) => [enc(k), enc(x)]));
}
function rawToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const int = (b: Uint8Array) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); if (b[0]! & 0x80) b = cat(Uint8Array.of(0), b); return cat(Uint8Array.of(2, b.length), b); };
  const body = cat(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return cat(Uint8Array.of(0x30, body.length), body);
}

async function device(origin: string, rp: string) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const unb = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
  const cose: [number, V][] = [[1, 2], [3, -7], [-1, 1], [-2, unb(jwk.x!)], [-3, unb(jwk.y!)]];
  const id = crypto.getRandomValues(new Uint8Array(32));
  let count = 0;
  const cd = (type: string, challenge: string) => te.encode(JSON.stringify({ type, challenge, origin }));
  const counter = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  return {
    credId: b64u(id),
    async create(challenge: string) {
      const authData = cat(await sha(te.encode(rp)), Uint8Array.of(0x45), counter(0), new Uint8Array(16), Uint8Array.of(0, id.length), id, enc(cose as V));
      return { clientDataJSON: b64u(cd("webauthn.create", challenge)), attestationObject: b64u(enc([["fmt", "none"], ["attStmt", []], ["authData", authData]])) };
    },
    async get(challenge: string) {
      const clientData = cd("webauthn.get", challenge);
      const authData = cat(await sha(te.encode(rp)), Uint8Array.of(0x05), counter(++count));
      const sig = rawToDer(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, cat(authData, await sha(clientData)))));
      return { id: b64u(id), clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig) };
    },
  };
}

describe("passkeys", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie = "";

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), redirect: "manual" });
  const authed = (path: string, body: unknown = {}) => post(path, body, { cookie });

  async function enroll(name: string) {
    const d = await device(new URL(base).origin, new URL(base).hostname);
    const opts = (await (await authed("/settings/passkeys/options")).json()) as any;
    const res = await authed("/settings/passkeys", { name, challenge: opts.challenge, ...(await d.create(opts.challenge)) });
    return { d, res };
  }
  async function signIn(d: Awaited<ReturnType<typeof device>>, qs = "") {
    const o = (await (await post("/signin/passkey/options", {})).json()) as any;
    return post(`/signin/passkey${qs}`, { challenge: o.challenge, ...(await d.get(o.challenge)) });
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-passkeys-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const res = await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({ username: "pat", email: "pat@f.dev", password: "passkey-password" }),
      redirect: "manual",
    });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("add two, remove one, sign in with the other; the removed one is refused", async () => {
    const one = await enroll("Laptop");
    const two = await enroll("Phone");
    expect(one.res.status).toBe(200);
    expect(two.res.status).toBe(200);

    let page = await (await fetch(`${base}/settings/passkeys`, { headers: { cookie } })).text();
    expect(page).toContain("Laptop");
    expect(page).toContain(`aria-label="Remove Phone"`);
    expect(page).toContain(`<div class="field"><span class="muted small" id="passkey-add-note" data-fail="error" role="status"></span></div>`);
    expect(page).not.toContain("error-note");

    const id = app.db.query<{ id: string }, []>("SELECT id FROM passkey WHERE name = 'Laptop'").get()!.id;
    const removed = await fetch(`${base}/settings/passkeys/${id}/delete`, { method: "POST", headers: { cookie }, redirect: "manual" });
    expect(removed.status).toBe(303);
    page = await (await fetch(`${base}/settings/passkeys`, { headers: { cookie } })).text();
    expect(page).not.toContain(`aria-label="Remove Laptop"`);
    expect(page).toContain(`aria-label="Remove Phone"`);

    const refused = await signIn(one.d);
    expect(refused.status).toBe(401);
    expect(refused.headers.get("set-cookie")).toBeNull();

    const good = await signIn(two.d, "?next=/settings");
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ ok: true, next: "/settings" });
    const set = good.headers.get("set-cookie")!;
    expect(set).toContain("forge_session=");
    expect(set).toContain("HttpOnly");
    const me = await fetch(`${base}/settings/passkeys`, { headers: { cookie: set.split(";")[0]! } });
    expect(me.status).toBe(200);
    expect(await me.text()).toContain("Phone");
  });

  test("a challenge answers once, and a bad signature or a stranger's key signs nobody in", async () => {
    const d = await device(new URL(base).origin, new URL(base).hostname);
    const o = (await (await post("/signin/passkey/options", {})).json()) as any;
    const unknown = await post("/signin/passkey", { challenge: o.challenge, ...(await d.get(o.challenge)) });
    expect(unknown.status).toBe(401);
    // The challenge is spent even by a refusal.
    const e = await enroll("Key");
    const spent = await post("/signin/passkey", { challenge: o.challenge, ...(await e.d.get(o.challenge)) });
    expect(spent.status).toBe(401);
    const o2 = (await (await post("/signin/passkey/options", {})).json()) as any;
    const forged = { challenge: o2.challenge, ...(await e.d.get(o2.challenge)) };
    const bad = await post("/signin/passkey", { ...forged, signature: b64u(new Uint8Array(70)) });
    expect(bad.status).toBe(401);
  });

  test("registration needs a session and a same-origin request, and a challenge is single-use", async () => {
    expect((await post("/settings/passkeys/options", {})).status).toBe(401);
    const cross = await post("/settings/passkeys/options", {}, { cookie, origin: "https://evil.example" });
    expect(cross.status).toBe(403);
    const crossSignin = await post("/signin/passkey/options", {}, { origin: "https://evil.example" });
    expect(crossSignin.status).toBe(403);

    const d = await device(new URL(base).origin, new URL(base).hostname);
    const opts = (await (await authed("/settings/passkeys/options")).json()) as any;
    const answer = { name: "x", challenge: opts.challenge, ...(await d.create(opts.challenge)) };
    expect((await authed("/settings/passkeys", answer)).status).toBe(200);
    expect((await authed("/settings/passkeys", answer)).status).toBe(400);
    // Enrolling the same device twice is also refused, with a fresh challenge.
    const again = (await (await authed("/settings/passkeys/options")).json()) as any;
    expect(again.exclude).toContain(d.credId);
    const dup = await authed("/settings/passkeys", { name: "x", challenge: again.challenge, ...(await d.create(again.challenge)) });
    expect(dup.status).toBe(409);
  });

  test("a name is escaped on the page, and the sign-in page offers a passkey", async () => {
    await enroll("<script>alert(1)</script>");
    const page = await (await fetch(`${base}/settings/passkeys`, { headers: { cookie } })).text();
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;alert(1)");
    expect(await (await fetch(`${base}/signin`)).text()).toContain("passkey-signin");
  });

  const signup = async (username: string) => {
    const res = await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({ username, email: `${username}@f.dev`, password: "passkey-password" }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  const userId = (name: string) => app.db.query<{ id: string }, [string]>("SELECT id FROM user WHERE username = ?1").get(name)!.id;

  test("another account cannot remove a passkey that is not theirs", async () => {
    await enroll("Pat's key");
    const id = app.db.query<{ id: string }, [string]>("SELECT id FROM passkey WHERE user_id = ?1 AND name = 'Pat''s key'").get(userId("pat"))!.id;
    const eve = await signup("eve");
    const res = await fetch(`${base}/settings/passkeys/${id}/delete`, { method: "POST", headers: { cookie: eve }, redirect: "manual" });
    expect(res.status).toBe(303);
    const carried = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
    const flash = await (await fetch(`${base}/settings/passkeys`, { headers: { cookie: `${eve}; ${carried}` } })).text();
    expect(flash).toContain("No such passkey.");
    expect(app.db.query("SELECT 1 FROM passkey WHERE id = ?1").get(id)).not.toBeNull();
  });

  test("a token cannot register a passkey", async () => {
    const { token } = createToken(app.db, userId("pat"), "ci", "admin");
    const headers = { authorization: `Bearer ${token}` };
    const before = app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM passkey").get()!.n;
    const opts = await post("/settings/passkeys/options", {}, headers);
    expect(opts.status).toBe(403);
    const d = await device(new URL(base).origin, new URL(base).hostname);
    const add = await post("/settings/passkeys", { name: "t", challenge: "x", ...(await d.create("x")) }, headers);
    expect(add.status).toBe(403);
    expect(app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM passkey").get()!.n).toBe(before);
  });

  test("a suspended account cannot sign in with its passkey", async () => {
    const dan = await signup("dan");
    const d = await device(new URL(base).origin, new URL(base).hostname);
    const opts = (await post("/settings/passkeys/options", {}, { cookie: dan }).then((r) => r.json())) as any;
    expect((await post("/settings/passkeys", { name: "d", challenge: opts.challenge, ...(await d.create(opts.challenge)) }, { cookie: dan })).status).toBe(200);
    app.db.query("UPDATE user SET suspended_at = ?1 WHERE username = 'dan'").run(new Date().toISOString());
    const res = await signIn(d);
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("passkey sign-in is rate limited, options and answer share one bucket", async () => {
    setLimit(app.db, "signin.per_account", 2, userId("pat"));
    // Earlier sign-ins from this address already spent some of the minute.
    let third = await post("/signin/passkey/options", {});
    for (let i = 0; i < 3 && third.status === 200; i++) third = await post("/signin/passkey/options", {});
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    const answer = await post("/signin/passkey", { challenge: "x" });
    expect(answer.status).toBe(429);
    expect(Number(answer.headers.get("retry-after"))).toBeGreaterThan(0);
    setLimit(app.db, "signin.per_account", null, userId("pat"));
  });
});
