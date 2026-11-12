/**
 * The platform's forwardAuth edge goes (#11802). Every account it signed in
 * is mapped once to its login (`edge_link`); with the edge gone an account
 * it made — a noreply address, no password, no passkey — gets in by a
 * way-back link an admin hands over, which registers a passkey and signs
 * in. `/healthz` and public pages answer with no edge headers at all.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { b64u } from "../src/auth/webauthn.ts";
import { edgeOnlyAccounts } from "../src/core/accounts.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { HANDOVER_TTL_MS } from "../src/core/edge_handover.ts";
import { mintWayBack } from "../src/actions/edge_handover.ts";
import { sha256 } from "../src/kernel/hash.ts";
import { serve, type Servers } from "../src/http/server.ts";
import migration from "../src/core/migrations/20261112180000-edge-handover.ts";

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
async function register(origin: string, rp: string, challenge: string) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const unb = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
  const cose: [number, V][] = [[1, 2], [3, -7], [-1, 1], [-2, unb(jwk.x!)], [-3, unb(jwk.y!)]];
  const id = crypto.getRandomValues(new Uint8Array(32));
  const authData = cat(await sha(te.encode(rp)), Uint8Array.of(0x45), new Uint8Array(4), new Uint8Array(16), Uint8Array.of(0, id.length), id, enc(cose as V));
  return {
    clientDataJSON: b64u(te.encode(JSON.stringify({ type: "webauthn.create", challenge, origin }))),
    attestationObject: b64u(enc([["fmt", "none"], ["attStmt", []], ["authData", authData]])),
  };
}

const EDGE = "edge-secret";

describe("the forge with its forwardAuth edge gone", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let ownerCookie: string;

  const linkOf = (userId: string) =>
    app.db.query<{ login: string }, [string]>("SELECT login FROM edge_link WHERE user_id = ?1").get(userId)?.login;
  const whoAmI = async (headers: Record<string, string>) => {
    const res = await fetch(`${base}/api/v1/user`, { headers });
    return res.status === 200 ? ((await res.json()) as { username: string }).username : res.status;
  };
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-edge-gone-"));
    // While the edge still stands in front of the forge.
    app = createApp({ dataDir, port: 0, edgeToken: EDGE });
    servers = await serve(app);
    base = servers.url;
    const owner = await createUser(app.db, { origin: "seed", trusted: true, username: "olga", email: "olga@f.dev", password: "owner-passphrase" });
    if (!owner.ok) throw new Error(owner.error);
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(owner.value.id);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("every account the edge signed in is mapped once to its login", async () => {
    // ada: an account the edge made, as it did before #2779 (a noreply address).
    const ada = await createUser(app.db, { origin: "edge", username: "ada", email: "ada@noreply.forge.example" });
    if (!ada.ok) throw new Error(ada.error);
    app.bus.append({ kind: "user.created", actorId: ada.value.id, payload: { via: "edge" } });
    // bea: an account of the forge's own the edge signed in by name.
    const bea = await createUser(app.db, { origin: "seed", trusted: true, username: "bea", email: "bea@f.dev", password: "bea-passphrase" });
    if (!bea.ok) throw new Error(bea.error);
    expect(linkOf(ada.value.id)).toBeUndefined();

    // The migration's backfill maps what the edge made.
    app.db.exec("DROP TABLE edge_handover");
    app.db.exec(migration);
    expect(linkOf(ada.value.id)).toBe("ada");
    expect(linkOf(bea.value.id)).toBeUndefined();

    // A sign-in through the edge by name maps that account, once.
    expect(await whoAmI({ "x-plat-user": "bea", "x-plat-edge-token": EDGE })).toBe("bea");
    expect(linkOf(bea.value.id)).toBe("bea");
    expect(await whoAmI({ "x-plat-user": "bea", "x-plat-edge-token": EDGE })).toBe("bea");
    expect(app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM edge_link").get()!.n).toBe(2);
    expect(await whoAmI({ "x-plat-user": "ada", "x-plat-edge-token": EDGE })).toBe("ada");
  });

  test("with the edge gone, an edge account walks back in by a way-back link", async () => {
    // The edge goes: the forge restarts with no edge secret.
    servers.stop();
    app.close();
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const owner = getUserByName(app.db, "olga")!;
    ownerCookie = `forge_session=${createSession(app.db, owner.id).token}`;

    // The edge's headers are now a claim anyone could write: nobody.
    expect(await whoAmI({ "x-plat-user": "ada", "x-plat-edge-token": EDGE })).toBe(401);
    expect(edgeOnlyAccounts(app.db).map((a) => a.username)).toEqual(["ada"]);

    // The owner sees ada stranded and makes her link.
    const card = await (await fetch(`${base}/settings/accounts`, { headers: { cookie: ownerCookie } })).text();
    expect(card).toContain(`action="/settings/accounts/ada/way-back"`);
    expect(card).not.toContain(`action="/settings/accounts/bea/way-back"`);
    const made = await fetch(`${base}/settings/accounts/ada/way-back`, { method: "POST", headers: { cookie: ownerCookie, origin: base } });
    expect(made.status).toBe(200);
    expect(made.headers.get("cache-control")).toBe("no-store");
    const token = /\/recover\?token=([\w-]+)/.exec(await made.text())![1]!;

    // Only its hash is kept, for a week.
    const row = app.db.query<{ token_hash: string; expires_at: string }, []>("SELECT token_hash, expires_at FROM edge_handover").get()!;
    expect(row.token_hash).toBe(sha256(token));
    const life = Date.parse(row.expires_at) - Date.now();
    expect(life).toBeGreaterThan(HANDOVER_TTL_MS - 60_000);
    expect(life).toBeLessThanOrEqual(HANDOVER_TTL_MS);

    // ada opens it: a new passkey, then a session of the forge's own.
    expect((await fetch(`${base}/recover?token=${token}`)).status).toBe(200);
    const o = await post("/recover/options", { token });
    expect(o.status).toBe(200);
    const opts = (await o.json()) as { challenge: string; user: { name: string } };
    expect(opts.user.name).toBe("ada");
    const reg = await register(new URL(base).origin, new URL(base).hostname, opts.challenge);
    const done = await post("/recover/passkey", { token, name: "Laptop", challenge: opts.challenge, ...reg });
    expect(done.status).toBe(200);
    const cookie = done.headers.get("set-cookie")!.split(";")[0]!;
    expect(await whoAmI({ cookie })).toBe("ada");
    expect(edgeOnlyAccounts(app.db)).toEqual([]);

    // The link works once.
    expect((await post("/recover/options", { token })).status).toBe(400);
  });

  test("only an admin mints one, only for a mapped account with no way in", async () => {
    const owner = getUserByName(app.db, "olga")!;
    const bea = getUserByName(app.db, "bea")!;
    // bea has a password: no link.
    expect(mintWayBack(app, owner, "bea")).toEqual({ ok: false, error: "has_way_in" });
    // Not for an account nobody mapped, not by a non-admin, not for an admin.
    const cy = await createUser(app.db, { origin: "seed", trusted: true, username: "cy", email: "cy@f.dev" });
    if (!cy.ok) throw new Error(cy.error);
    expect(mintWayBack(app, owner, "cy")).toEqual({ ok: false, error: "not_found" });
    expect(mintWayBack(app, bea, "ada")).toEqual({ ok: false, error: "not_found" });
    expect(mintWayBack(app, owner, "olga")).toEqual({ ok: false, error: "not_found" });
    const beaCookie = `forge_session=${createSession(app.db, bea.id).token}`;
    const refused = await fetch(`${base}/settings/accounts/ada/way-back`, { method: "POST", headers: { cookie: beaCookie, origin: base } });
    expect(refused.status).toBe(404);
    // From another site: refused before anything is made.
    const crossed = await fetch(`${base}/settings/accounts/ada/way-back`, { method: "POST", headers: { cookie: ownerCookie, origin: "https://elsewhere.example" } });
    expect(crossed.status).toBe(403);
  });
});

describe("no other service up", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-no-edge-"));
    // An edge secret configured and nothing in front: no request carries its headers.
    app = createApp({ dataDir, port: 0, edgeToken: EDGE });
    servers = await serve(app);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("/healthz and the public pages answer with no edge headers at all", async () => {
    for (const path of ["/healthz", "/", "/signin", "/explore", "/recover"]) {
      const res = await fetch(`${servers.url}${path}`, { redirect: "manual" });
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
      await res.arrayBuffer();
    }
  });
});
