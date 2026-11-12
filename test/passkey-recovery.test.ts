/**
 * Recovering an account by email: a verified address gets a single-use,
 * 30-minute link that registers a new passkey and signs in. Expired, reused
 * and forged links are refused; an unknown address is answered like a known
 * one; the token is stored only as a hash.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { b64u } from "../src/auth/webauthn.ts";
import { addPasskey, PASSKEY_MAX } from "../src/core/passkeys.ts";
import { consumeLink, issueRecovery, markVerified, RECOVERY_TTL_MS } from "../src/core/verify.ts";
import { sha256 } from "../src/kernel/hash.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { Mail } from "../src/kernel/mail.ts";

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

/** A software authenticator that can only register. */
async function register(origin: string, rp: string, challenge: string, fixedId?: Uint8Array) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const unb = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
  const cose: [number, V][] = [[1, 2], [3, -7], [-1, 1], [-2, unb(jwk.x!)], [-3, unb(jwk.y!)]];
  const id = fixedId ?? crypto.getRandomValues(new Uint8Array(32));
  const authData = cat(await sha(te.encode(rp)), Uint8Array.of(0x45), new Uint8Array(4), new Uint8Array(16), Uint8Array.of(0, id.length), id, enc(cose as V));
  return {
    clientDataJSON: b64u(te.encode(JSON.stringify({ type: "webauthn.create", challenge, origin }))),
    attestationObject: b64u(enc([["fmt", "none"], ["attStmt", []], ["authData", authData]])),
  };
}

describe("passkey recovery", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  const sent: Mail[] = [];

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "manual" });
  const ask = (email: string) =>
    fetch(`${base}/recover`, {
      method: "POST",
      body: new URLSearchParams({ email }),
    });
  const linkOf = (mail: Mail): string => /token=([\w-]+)/.exec(mail.text)![1]!;
  async function finish(token: string, fixedId?: Uint8Array) {
    const o = await post("/recover/options", { token });
    if (o.status !== 200) return { options: o, done: undefined };
    const opts = (await o.json()) as any;
    const origin = new URL(base);
    const reg = await register(origin.origin, origin.hostname, opts.challenge, fixedId);
    return { options: o, done: await post("/recover/passkey", { token, name: "Laptop", challenge: opts.challenge, ...reg }) };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-recover-"));
    app = createApp({
      dataDir,
      port: 0,
      mailer: async (mail) => { sent.push(mail); return true; },
    });
    servers = await serve(app);
    base = servers.url;
    for (const [name, email] of [["pat", "pat@f.dev"], ["una", "una@f.dev"]] as const) {
      await fetch(`${base}/signup`, {
        method: "POST",
        body: new URLSearchParams({ username: name, email, password: "recover-password" }),
        redirect: "manual",
      });
    }
    // The first account is the owner; pat is the person who verifies.
    const id = (n: string) => app.db.query<{ id: string }, [string]>("SELECT id FROM user WHERE username = ?1").get(n)!.id;
    markVerified(app.db, id("pat"), new Date().toISOString());
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a verified address gets a link that registers a passkey, signs in, and works once", async () => {
    sent.length = 0;
    const res = await ask("PAT@f.dev");
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("pat@f.dev");
    const token = linkOf(sent[0]!);

    // Only a hash is kept.
    const row = app.db.query<{ token_hash: string; expires_at: string }, []>("SELECT token_hash, expires_at FROM email_check WHERE token_hash IS NOT NULL AND verified_at IS NOT NULL").get()!;
    expect(row.token_hash).toBe(sha256(token));
    expect(JSON.stringify(row)).not.toContain(token);
    const life = Date.parse(row.expires_at) - Date.now();
    expect(life).toBeGreaterThan(RECOVERY_TTL_MS - 60_000);
    expect(life).toBeLessThanOrEqual(RECOVERY_TTL_MS);

    // Opening the page spends nothing.
    expect((await fetch(`${base}/recover?token=${token}`)).status).toBe(200);

    const { done } = await finish(token);
    expect(done!.status).toBe(200);
    expect(await done!.json()).toEqual({ ok: true, next: "/settings/passkeys" });
    const cookie = done!.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    const keys = await fetch(`${base}/settings/passkeys`, { headers: { cookie: cookie.split(";")[0]! } });
    expect(await keys.text()).toContain(`aria-label="Remove Laptop"`);

    // Reused: refused, and no second session.
    const again = await finish(token);
    expect(again.options.status).toBe(400);
    expect((await fetch(`${base}/recover?token=${token}`)).status).toBe(400);
  });

  test("an expired link and a forged one are refused with one sentence", async () => {
    sent.length = 0;
    await ask("pat@f.dev");
    const token = linkOf(sent[0]!);
    app.db.query("UPDATE email_check SET expires_at = ?1 WHERE token_hash = ?2").run(new Date(Date.now() - 1000).toISOString(), sha256(token));
    const expired = await finish(token);
    expect(expired.options.status).toBe(400);
    const sentence = ((await expired.options.json()) as any).message as string;
    const forged = await post("/recover/options", { token: "not-a-real-token" });
    expect(forged.status).toBe(400);
    expect(((await forged.json()) as any).message).toBe(sentence);
    const page = await fetch(`${base}/recover?token=${token}`);
    expect(page.status).toBe(400);
    expect(await page.text()).toContain(sentence);
    expect((await post("/recover/options", {})).status).toBe(400);
  });

  test("a pending verification link opens nothing here", async () => {
    // una never proved the address: her verification link must not sign in.
    const una = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'una'").get()!.id;
    app.db.query("UPDATE email_check SET verified_at = NULL, token_hash = ?2, expires_at = ?3 WHERE user_id = ?1").run(una, sha256("pending"), new Date(Date.now() + 60_000).toISOString());
    expect((await post("/recover/options", { token: "pending" })).status).toBe(400);
    sent.length = 0;
    await ask("una@f.dev");
    expect(sent).toHaveLength(0);
  });

  test("an unknown address is answered exactly like a known one", async () => {
    const known = await ask("pat@f.dev");
    const unknown = await ask("nobody@f.dev");
    expect(unknown.status).toBe(known.status);
    const plain = async (r: Response) => (await r.text()).replace(/nonce="[^"]*"/g, "");
    expect(await plain(unknown)).toBe(await plain(known));
  });

  test("asking is limited per address and per source", async () => {
    sent.length = 0;
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await ask("limit@f.dev")).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  test("asking is limited per source, whatever the addresses", async () => {
    const other = createApp({ dataDir: await mkdtemp(join(tmpdir(), "forge-recover-src-")), port: 0 });
    const more = await serve(other);
    try {
      const source: number[] = [];
      for (let i = 0; i < 11; i++)
        source.push((await fetch(`${more.url}/recover`, { method: "POST", body: new URLSearchParams({ email: `s${i}@f.dev` }) })).status);
      expect(source.slice(0, 10)).toEqual(Array(10).fill(200));
      expect(source[10]).toBe(429);
    } finally {
      more.stop();
      other.close();
      await rm(other.config.dataDir, { recursive: true, force: true });
    }
  });

  test("a link that cannot add its passkey is not spent", async () => {
    const pat = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'pat'").get()!.id;
    const mint = async () => issueRecovery(app.db, pat, Date.now())!;
    const usable = async (t: string) => (await post("/recover/options", { token: t })).status === 200;

    // A duplicate credential.
    const dup = crypto.getRandomValues(new Uint8Array(32));
    const t1 = await mint();
    expect((await finish(t1, dup)).done!.status).toBe(200);
    const t2 = await mint();
    expect((await finish(t2, dup)).done!.status).toBe(409);
    expect(await usable(t2)).toBe(true);

    // An account at the limit.
    const have = app.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM passkey WHERE user_id = ?1").get(pat)!.n;
    for (let i = have; i < PASSKEY_MAX; i++)
      addPasskey(app.db, pat, `k${i}`, { id: `fill-${i}`, alg: -7 as never, key: {} as any, signCount: 0 });
    const t3 = await mint();
    expect((await finish(t3)).done!.status).toBe(409);
    expect(await usable(t3)).toBe(true);
  });

  test("a recovery link opened at /verify is not burned", () => {
    const pat = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'pat'").get()!.id;
    app.db.query("UPDATE email_check SET token_hash = ?2, expires_at = ?3 WHERE user_id = ?1").run(pat, sha256("rec"), new Date(Date.now() + 60_000).toISOString());
    expect(consumeLink(app.db, "rec", Date.now())).toBeUndefined();
    expect(app.db.query("SELECT token_hash FROM email_check WHERE user_id = ?1").get(pat)).toEqual({ token_hash: sha256("rec") });
  });
});
