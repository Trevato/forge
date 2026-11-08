/**
 * With `signup` closed (or `invite`, which acts as closed), no new account is
 * made by any door, the forge's first neither; a switch is live.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { setLimit } from "../src/settings/limits.ts";
import { setSignup, type SignupMode } from "../src/settings/signup.ts";
import { signUp, signUpWithPasskey } from "../src/actions/users.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { fixtureSlot } from "./helpers/slot.ts";

const TOKEN = "edge-secret-0123456789";
const edge = (login: string) => ({ "x-plat-user": login, "x-plat-edge-token": TOKEN });

describe("closed signup", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-signup-closed-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.example", edgeToken: TOKEN });
    servers = await serve(app);
    setLimit(app.db, "signup.per_source", 1000, "setup");
    // Accounts the edge made when it still did; they keep signing in.
    for (const name of ["founder", "edgy"])
      await createUser(app.db, { origin: "edge", username: name, email: `${name}@forge.example` });
    base = servers.url;
  });
  afterAll(async () => {
    await servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const mode = (m: SignupMode) => setSignup(app.db, m, "boot");
  const post = (username: string) =>
    fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://forge.example", ...edge(username) },
      body: JSON.stringify({ username, email: `${username}@example.com`, password: "a-good-passphrase" }),
    });
  const me = (login: string) => fetch(`${base}/api/v1/user`, { headers: edge(login) });

  test("closed: an unknown edge login is signed out and told signup is closed", async () => {
    mode("closed");
    expect((await me("stranger")).status).toBe(401);
    const page = await fetch(`${base}/signup`, { headers: edge("stranger") }).then((r) => r.text());
    expect(page).toContain("Signup is closed on this forge.");
    expect(page).not.toContain("Sign out");
    expect(getUserByName(app.db, "stranger")).toBeUndefined();
  });

  for (const closed of ["closed", "invite"] as const) {
    test(`${closed}: page, API and edge make no account`, async () => {
      mode(closed);
      const page = await fetch(`${base}/signup`);
      const html = await page.text();
      expect(html).toContain("Signup is closed on this forge.");
      expect(html).not.toContain('name="password"');

      const res = await post(`via-api-${closed}`);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("signup_closed");
      expect(body.message).toContain("closed");
      expect(getUserByName(app.db, `via-api-${closed}`)).toBeUndefined();

      expect((await me(`via-edge-${closed}`)).status).toBe(401);
      expect(getUserByName(app.db, `via-edge-${closed}`)).toBeUndefined();
    });
  }

  test("existing accounts still sign in through the edge when closed", async () => {
    mode("open");
    expect((await me("founder")).status).toBe(200);
    mode("closed");
    expect((await me("founder")).status).toBe(200);
  });

  test("open makes accounts; switching takes effect on the next request", async () => {
    mode("open");
    const form = await (await fetch(`${base}/signup`, { headers: edge("newcomer") })).text();
    expect(form).toContain('name="password"');
    expect(form).toContain("Optional. If you add one, we send a link to confirm it.");
    expect(form.split("Optional").length - 1).toBe(1);
    expect((await post("newcomer")).status).toBe(201);
    expect((await me("edgy")).status).toBe(200);
    expect((await me("later")).status).toBe(401);
    mode("closed");
    expect((await post("late")).status).toBe(403);
    expect((await me("later")).status).toBe(401);
    mode("open");
    expect((await post("late")).status).toBe(201);
  });

  test("closed: the passkey and form doors and the terminal refuse too", async () => {
    mode("closed");
    const json = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://forge.example" },
        body: JSON.stringify(body),
      });
    const options = await json("/signup/passkey/options", { username: "pk", email: "pk@example.com" });
    expect(options.status).toBe(403);
    expect(JSON.stringify(await options.json())).toContain("Signup is closed on this forge.");

    const form = await fetch(`${base}/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://forge.example" },
      body: new URLSearchParams({ username: "formed", email: "f@example.com", password: "a-good-passphrase" }),
    });
    expect(form.status).toBe(403);
    expect(await form.text()).toContain("Signup is closed on this forge.");
    expect(getUserByName(app.db, "formed")).toBeUndefined();

    const input = { username: "direct", email: "d@example.com" };
    const key = await signUpWithPasskey(app, { ...input, passkey: {} as never, passkeyName: "k" }, { slot: fixtureSlot(app) });
    expect(key).toEqual({ ok: false, error: "signup_closed" });
    const terminal = await signUp(app, { ...input, password: "a-good-passphrase" }, { slot: fixtureSlot(app) });
    expect(terminal).toEqual({ ok: false, error: "signup_closed" });
    expect(getUserByName(app.db, "direct")).toBeUndefined();
  });
});
