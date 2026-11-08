/**
 * Sign-up with a username and a password, email optional (#2923): the
 * account is made with neither passkey nor email and signs in; a short
 * password, a closed forge and a cross-origin post are refused; none of it
 * needs an edge or origin configured.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { requireVerified } from "../src/actions/verify.ts";
import { updateProfile } from "../src/core/users.ts";
import { emailVerified } from "../src/core/verify.ts";
import { getUserByName, verifyPasswordThrottled } from "../src/core/users.ts";
import { setLimit } from "../src/settings/limits.ts";
import { setSignup } from "../src/settings/signup.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("password sign-up", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  const mails: { to: string }[] = [];

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-signup-password-"));
    delete process.env.FORGE_EDGE_TOKEN;
    app = createApp({
      dataDir,
      port: 0,
      mailer: async (m) => {
        mails.push({ to: m.to });
        return true;
      },
    });
    servers = await serve(app);
    base = servers.url;
    setLimit(app.db, "signup.per_source", 100, "system");
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an account with neither passkey nor email signs up and signs in", async () => {
    const res = await post({ username: "quinn", password: "a-long-passphrase" });
    expect(res.status).toBe(201);
    const user = getUserByName(app.db, "quinn")!;
    expect(user.email.endsWith(".invalid")).toBe(true);
    expect(emailVerified(app.db, user.id)).toBe(false);
    expect(requireVerified(app, user)).toEqual({ ok: false, error: "unverified" });
    expect(mails.length).toBe(0);
    const hash = app.db.query<{ password_hash: string }, [string]>("SELECT password_hash FROM user WHERE id = ?1").get(user.id)!;
    expect(hash.password_hash.startsWith("$argon2id$")).toBe(true);
    const verified = await verifyPasswordThrottled(app.db, { username: "quinn", password: "a-long-passphrase", source: "test" });
    expect(verified.ok).toBe(true);
    const basic = await fetch(`${base}/api/v1/user`, {
      headers: { authorization: `Basic ${btoa("quinn:a-long-passphrase")}` },
    });
    expect(basic.status).toBe(200);
  });

  test("a second account with no email does not collide with the first", async () => {
    expect((await post({ username: "rae", password: "another-passphrase" })).status).toBe(201);
  });

  test("a given email gets the verify mail and starts unproven", async () => {
    const res = await post({ username: "sol", password: "a-long-passphrase", email: "sol@f.dev" });
    expect(res.status).toBe(201);
    expect(mails.map((m) => m.to)).toEqual(["sol@f.dev"]);
    expect(emailVerified(app.db, getUserByName(app.db, "sol")!.id)).toBe(false);
  });

  test("a stand-in address cannot be taken in settings, and shows empty", () => {
    const rae = getUserByName(app.db, "quinn")!;
    const other = getUserByName(app.db, "sol") ?? rae;
    expect(updateProfile(app.db, other.id, { email: rae.email }).ok).toBe(false);
    expect(updateProfile(app.db, other.id, { email: "x@no-email.invalid" }).ok).toBe(false);
    const kept = updateProfile(app.db, rae.id, { email: "", displayName: "Quinn" });
    expect(kept.ok && kept.value.email).toBe(rae.email);
  });

  test("a stand-in address cannot be given, and a malformed one is refused", async () => {
    expect((await post({ username: "tam", password: "a-long-passphrase", email: "tam@x.invalid" })).status).toBe(422);
    expect((await post({ username: "tam", password: "a-long-passphrase", email: "nope" })).status).toBe(422);
  });

  test("a password under 12 characters is refused", async () => {
    const res = await post({ username: "uma", password: "elevenchars" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("weak_password");
    expect(getUserByName(app.db, "uma")).toBeUndefined();
  });

  test("the form signs up with no email and sets an HttpOnly session", async () => {
    const page = await fetch(`${base}/signup`);
    const text = await page.text();
    expect(text).toContain('id="passkey-signup"');
    const form = (text.match(/<form[\s\S]*?<\/form>/g) ?? []).join(" ");
    const words = form.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    expect(words.match(/optional/gi)?.length).toBe(1);
    expect(words).toContain(
      "Or skip the password and use a passkey: your fingerprint, face or device PIN.",
    );
    const res = await fetch(`${base}/signup`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
      body: new URLSearchParams({ username: "vic", email: "", password: "a-long-passphrase" }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(getUserByName(app.db, "vic")).toBeDefined();
  });

  test("a cross-origin post is refused", async () => {
    const api = await post({ username: "wes", password: "a-long-passphrase" }, { origin: "https://evil.example" });
    expect(api.status).toBe(403);
    const form = await fetch(`${base}/signup`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: new URLSearchParams({ username: "wes", password: "a-long-passphrase" }),
    });
    expect(form.status).toBe(403);
    expect(getUserByName(app.db, "wes")).toBeUndefined();
  });

  test("a closed forge refuses", async () => {
    setSignup(app.db, "closed", "system");
    const res = await post({ username: "xan", password: "a-long-passphrase" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("signup_closed");
    expect(getUserByName(app.db, "xan")).toBeUndefined();
    setSignup(app.db, "open", "system");
  });
});
