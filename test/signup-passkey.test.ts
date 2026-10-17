/**
 * Sign-up takes a passkey and an email, and no door makes a password-only
 * account: the web form, the API and the terminal each refuse in plain words,
 * an account signed up with a passkey has its email and its key, and an
 * account that already has a password still signs in.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { signUp } from "../src/actions/users.ts";
import { createUser } from "../src/core/users.ts";
import { setLimit } from "../src/settings/limits.ts";
import { errorText } from "../src/tui/screens/common.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { device } from "./helpers/passkey.ts";
import { fixtureSlot } from "./helpers/slot.ts";

describe("passkey sign-up", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  const origin = () => new URL(base).origin;
  const rp = () => new URL(base).hostname;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "manual" });

  async function signUpWith(d: Awaited<ReturnType<typeof device>>, username: string, email: string) {
    const o = (await (await post("/signup/passkey/options", { username, email })).json()) as any;
    return post("/signup/passkey", { username, email, challenge: o.challenge, ...(await d.create(o.challenge)) });
  }

  const getOlive = async () => app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'olive'").get()!.id;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-signup-passkey-"));
    app = createApp({ dataDir, port: 0, passkeyOnlySignup: true });
    servers = await serve(app);
    base = servers.url;
    await createUser(app.db, { origin: "seed", username: "olive", email: "olive@f.dev", password: "olive-password-1", trusted: true });
    // This suite signs up more than five times a minute from one source.
    setLimit(app.db, "signup.per_source", 100, (await getOlive()));
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a passkey and an email make the account, its key and a session", async () => {
    const d = await device(origin(), rp());
    const res = await signUpWith(d, "nova", "nova@f.dev");
    expect(res.status).toBe(201);
    const set = res.headers.get("set-cookie")!;
    expect(set).toContain("forge_session=");
    expect(set).toContain("HttpOnly");
    const user = app.db.query<{ id: string; email: string; password_hash: string }, []>("SELECT * FROM user WHERE username = 'nova'").get()!;
    expect(user.email).toBe("nova@f.dev");
    expect(user.password_hash).toBe("");
    const key = app.db.query<{ credential_id: string }, [string]>("SELECT credential_id FROM passkey WHERE user_id = ?1").all(user.id);
    expect(key.map((k) => k.credential_id)).toEqual([d.credId]);
    const mine = await fetch(`${base}/settings/passkeys`, { headers: { cookie: set.split(";")[0]! } });
    expect(mine.status).toBe(200);
    // And the key signs back in.
    const o = (await (await post("/signin/passkey/options", {})).json()) as any;
    const back = await post("/signin/passkey", { challenge: o.challenge, ...(await d.get(o.challenge)) });
    expect(back.status).toBe(200);
  });

  test("a credential already registered makes no second account", async () => {
    const d = await device(origin(), rp());
    expect((await signUpWith(d, "reuse1", "reuse1@f.dev")).status).toBe(201);
    const before = app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM user").get()!.n;
    const again = await signUpWith(d, "reuse2", "reuse2@f.dev");
    expect(again.status).toBe(409);
    expect(again.headers.get("set-cookie")).toBeNull();
    expect(((await again.json()) as any).message).toContain("already registered");
    expect(app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM user").get()!.n).toBe(before);
    expect(app.db.query("SELECT 1 FROM user WHERE username = 'reuse2'").get()).toBeNull();
  });

  test("?next= lands on a safe path; an off-site one falls back to /", async () => {
    for (const [i, [qs, want]] of ([["?next=/settings", "/settings"], ["?next=https://evil.example/", "/"], ["?next=//evil.example", "/"]] as const).entries()) {
      const d = await device(origin(), rp());
      const name = `nexty${i}`;
      const o = (await (await post("/signup/passkey/options", { username: name, email: `${name}@f.dev` })).json()) as any;
      const res = await post(`/signup/passkey${qs}`, { username: name, email: `${name}@f.dev`, challenge: o.challenge, ...(await d.create(o.challenge)) });
      expect(res.status).toBe(201);
      expect(((await res.json()) as any).next).toBe(want);
    }
  });

  test("a bad name, a bad address, a taken name or a replayed challenge makes nothing", async () => {
    const bad = await post("/signup/passkey/options", { username: "x y", email: "a@f.dev" });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as any).message).toContain("Usernames");
    const mail = await post("/signup/passkey/options", { username: "zed", email: "not-an-address" });
    expect(mail.status).toBe(422);
    const taken = await post("/signup/passkey/options", { username: "olive", email: "o2@f.dev" });
    expect(taken.status).toBe(422);
    const d = await device(origin(), rp());
    const o = (await (await post("/signup/passkey/options", { username: "zed", email: "zed@f.dev" })).json()) as any;
    const made = await d.create(o.challenge);
    expect((await post("/signup/passkey", { username: "zed", email: "zed@f.dev", challenge: o.challenge, ...made })).status).toBe(201);
    const replay = await post("/signup/passkey", { username: "zed2", email: "zed2@f.dev", challenge: o.challenge, ...made });
    expect(replay.status).toBe(400);
    expect(app.db.query("SELECT 1 FROM user WHERE username = 'zed2'").get()).toBeNull();
    const cross = await fetch(`${base}/signup/passkey/options`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
    expect(cross.status).toBe(403);
  });

  test("a password-only sign-up is refused on the web form, the API and the terminal", async () => {
    const before = app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM user").get()!.n;

    const form = await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({ username: "webby", email: "webby@f.dev", password: "webby-password-1" }),
      redirect: "manual",
    });
    expect(form.status).toBe(422);
    expect(form.headers.get("set-cookie")).toBeNull();
    const html = await form.text();
    expect(html).toContain("sign up with a passkey and an email address");
    expect(html).not.toContain('name="password"');

    const api = await post("/api/v1/users", { username: "apiy", email: "apiy@f.dev", password: "apiy-password-1" });
    expect(api.status).toBe(422);
    const apiBody = (await api.json()) as any;
    expect(apiBody.error).toBe("passkey_required");
    expect(apiBody.message ?? JSON.stringify(apiBody)).toContain("passkey");

    // The terminal calls this action, bootstrap door included.
    for (const door of [undefined, "terminal" as const]) {
      const t = await signUp(app, { username: "termy", email: "termy@f.dev", password: "termy-password-1" }, { slot: fixtureSlot(app), ...(door ? { door } : {}) });
      expect(t.ok).toBe(false);
      if (!t.ok) {
        expect(t.error).toBe("passkey_required");
        expect(errorText(t.error)).toContain("passkey");
      }
    }
    expect(app.db.query<{ n: number }, []>("SELECT count(*) AS n FROM user").get()!.n).toBe(before);
  });

  test("an existing password account still signs in, and is invited to add a passkey", async () => {
    const res = await post("/api/v1/sessions", { username: "olive", password: "olive-password-1" });
    expect(res.status).toBe(201);
    const form = await fetch(`${base}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "olive", password: "olive-password-1" }),
      redirect: "manual",
    });
    const cookie = (form.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toContain("forge_session=");
    const page = await (await fetch(`${base}/settings/passkeys`, { headers: { cookie } })).text();
    expect(page).toContain("Your password still works; add a passkey now");
  });
});

describe("passkey sign-up and the bot check", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let human = false;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "manual" });
  async function attempt(username: string) {
    const d = await device(new URL(base).origin, new URL(base).hostname);
    const email = `${username}@f.dev`;
    const o = (await (await post("/signup/passkey/options", { username, email })).json()) as any;
    return post("/signup/passkey", { username, email, humanToken: "t", challenge: o.challenge, ...(await d.create(o.challenge)) });
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-signup-human-"));
    app = createApp({
      dataDir,
      port: 0,
      passkeyOnlySignup: true,
      turnstileSecret: "secret",
      turnstileSiteKey: "site",
      verifyHuman: async () => human,
    });
    servers = await serve(app);
    base = servers.url;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a failed human check makes no account; a passed one does", async () => {
    human = false;
    const refused = await attempt("robot");
    expect(refused.status).toBe(422);
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(((await refused.json()) as any).message).toContain("could not tell you are a person");
    expect(app.db.query("SELECT 1 FROM user WHERE username = 'robot'").get()).toBeNull();
    human = true;
    expect((await attempt("person")).status).toBe(201);
    expect(app.db.query("SELECT 1 FROM user WHERE username = 'person'").get()).not.toBeNull();
  });
});
