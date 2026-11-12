/**
 * Request access, the edges (#10928): the migration leaves a closed forge
 * closed, waiting requests are capped and the phone hears a count past a few,
 * the terminal answers requests, and the pieces an answer rests on: a waiting
 * passkey starts no session, a stored quota beats the newcomer's, an open
 * invite vouches in `request` mode, an answer is made once, and the list is
 * an admin's alone.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mint } from "../src/actions/invites.ts";
import { LINES_EACH, requestLines } from "../src/actions/requests.ts";
import { WAITING_CAP, waitingCount } from "../src/core/requests.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { NEWCOMER_QUOTAS, quotaOf, setQuota } from "../src/settings/quotas.ts";
import { setLimit } from "../src/settings/limits.ts";
import { getSignup, setSignup } from "../src/settings/signup.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { device } from "./helpers/passkey.ts";
import { adminCookie } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const ORIGIN = "https://forge.example";
const PASS = "a-good-passphrase-1";

let dir: string;
let app: App;
let servers: Servers;
let base: string;
let admin: string;

beforeAll(async () => {
  dir = await new Promise<string>((res, rej) => mkdtemp(join(tmpdir(), "forge-request-limits-"), (e, d) => (e ? rej(e) : res(d))));
  app = createApp({ dataDir: dir, port: 0, url: ORIGIN });
  servers = await serve(app);
  base = servers.url;
  setLimit(app.db, "signup.per_source", 1000, "setup");
  admin = await adminCookie(app, { username: "ada", email: "ada@example.com" });
  setSignup(app.db, "request", "boot");
});
afterAll(async () => {
  await servers.stop();
  app.close();
  await new Promise<void>((r) => rm(dir, { recursive: true, force: true }, () => r()));
});

const api = (username: string, extra: Record<string, string> = {}) =>
  fetch(`${base}/api/v1/users`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ username, password: PASS, ...extra }),
  });

/** Fill the Waiting list straight in the database: the cap is about rows, not about hashing. */
function fillWaiting(prefix: string, n: number): void {
  const at = new Date().toISOString();
  app.db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const id = `fill-${prefix}-${i}`;
      app.db.query("INSERT INTO user (id, username, email, password_hash, waiting_at) VALUES (?1, ?2, ?3, '', ?4)").run(id, `${prefix}${i}`, `${prefix}${i}@x.test`, at);
      app.db.query("INSERT INTO account_request (user_id, note, source, state, asked_at) VALUES (?1, '', '', 'waiting', ?2)").run(id, at);
    }
  })();
}
const clearFill = (): void => {
  app.db.query("DELETE FROM account_request WHERE user_id LIKE 'fill-%'").run();
  app.db.query("DELETE FROM user WHERE id LIKE 'fill-%'").run();
};

describe("the migration", () => {
  test("changes no stored setting, so a closed forge stays closed", () => {
    const text = readFileSync(join(import.meta.dir, "../src/core/migrations/20261110160000-account-requests.ts"), "utf8");
    expect(text).not.toMatch(/forge_setting/);
  });
});

describe("the Waiting list is bounded", () => {
  test("past the cap a stranger meets the closed door; an open invite still vouches; an answer reopens it", async () => {
    clearFill();
    fillWaiting("w", WAITING_CAP);
    expect(waitingCount(app.db)).toBe(WAITING_CAP);
    const refused = await api("onetoomany");
    expect(refused.status).toBe(403);
    expect(getUserByName(app.db, "onetoomany")).toBeUndefined();

    const token = mint(app, getUserByName(app.db, "ada"), 7);
    if (!token.ok) throw new Error("no invite");
    const vouched = await api("vouched", { invite: token.value.token });
    expect(vouched.status).toBe(201);
    expect(getUserByName(app.db, "vouched")?.waitingAt).toBeNull();

    app.db.query("DELETE FROM account_request WHERE user_id = 'fill-w-0'").run();
    expect((await api("roomagain")).status).toBe(202);
    clearFill();
  });

  test("the phone hears each of a few, then one count line", () => {
    clearFill();
    const ada = getUserByName(app.db, "ada")!;
    app.db.query("DELETE FROM account_request WHERE state = 'waiting'").run();
    fillWaiting("n", LINES_EACH);
    expect(requestLines(app.db, ada).length).toBe(LINES_EACH);
    fillWaiting("m", 40);
    const many = requestLines(app.db, ada);
    expect(many.length).toBe(1);
    expect(many[0]!.line).toBe(`${LINES_EACH + 40} people ask for an account`);
    fillWaiting("k", 1);
    // A flood moves the id slowly: the same id for a few more.
    expect(requestLines(app.db, ada)[0]!.id).toBe(many[0]!.id);
    clearFill();
  });
});

describe("what an answer rests on", () => {
  test("a waiting account's passkey sign-in starts no session; once allowed it does", async () => {
    const res = await fetch(`${base}/signup`, {
      method: "POST",
      headers: { origin: ORIGIN },
      body: new URLSearchParams({ username: "keyed", email: "keyed@f.dev", password: PASS }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    const keyed = getUserByName(app.db, "keyed")!;
    // Enrol a key as if the stranger had a session, then ask to be let in.
    app.db.query("UPDATE user SET waiting_at = NULL WHERE id = ?1").run(keyed.id);
    const cookie = `forge_session=${createSession(app.db, keyed.id).token}`;
    const d = await device(ORIGIN);
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...headers }, body: JSON.stringify(body), redirect: "manual" });
    const opts = (await (await post("/settings/passkeys/options", {}, { cookie })).json()) as { challenge: string };
    expect((await post("/settings/passkeys", { name: "k", challenge: opts.challenge, ...(await d.create(opts.challenge)) }, { cookie })).status).toBe(200);
    const signIn = async () => {
      const o = (await (await post("/signin/passkey/options", {})).json()) as { challenge: string };
      return post("/signin/passkey", { challenge: o.challenge, ...(await d.get(o.challenge)) });
    };
    app.db.query("UPDATE user SET waiting_at = ?1 WHERE id = ?2").run(new Date().toISOString(), keyed.id);
    const waiting = await signIn();
    expect(waiting.status).toBe(202);
    expect(waiting.headers.get("set-cookie")).toBeNull();
    app.db.query("UPDATE user SET waiting_at = NULL WHERE id = ?1").run(keyed.id);
    const allowed = await signIn();
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("set-cookie")).toContain("forge_session=");
  });

  test("a stored quota beats the newcomer's; the newcomer's holds only for an allowed request", async () => {
    expect((await api("quota1")).status).toBe(202);
    const person = getUserByName(app.db, "quota1")!;
    expect(quotaOf(app.db, "apps", person.id)).toBeNull();
    const allow = await fetch(`${base}/api/v1/admin/requests/quota1/allow`, { method: "POST", headers: { cookie: admin, origin: ORIGIN } });
    expect(allow.status).toBe(200);
    expect(quotaOf(app.db, "apps", person.id)).toBe(NEWCOMER_QUOTAS.apps);
    setQuota(app.db, "apps", (NEWCOMER_QUOTAS.apps ?? 0) + 40, "ada");
    expect(quotaOf(app.db, "apps", person.id)).toBe((NEWCOMER_QUOTAS.apps ?? 0) + 40);
  });

  test("an open invite vouches in request mode: no wait, and the invite is spent", async () => {
    expect(getSignup(app.db)).toBe("request");
    const token = mint(app, getUserByName(app.db, "ada"), 7);
    if (!token.ok) throw new Error("no invite");
    const res = await api("guest1", { invite: token.value.token });
    expect(res.status).toBe(201);
    expect(getUserByName(app.db, "guest1")?.waitingAt).toBeNull();
    const again = await api("guest2", { invite: token.value.token });
    expect(again.status).toBe(202);
    expect(getUserByName(app.db, "guest2")?.waitingAt).not.toBeNull();
  });

  test("an answer is made once, and the list is an admin's alone", async () => {
    expect((await api("once")).status).toBe(202);
    const answer = () => fetch(`${base}/api/v1/admin/requests/once/decline`, { method: "POST", headers: { cookie: admin, origin: ORIGIN } });
    expect((await answer()).status).toBe(200);
    expect((await answer()).status).toBe(409);
    const member = await createUser(app.db, { origin: "seed", trusted: true, username: "plain", email: "plain@f.dev", password: PASS });
    if (!member.ok) throw new Error(member.error);
    const cookie = `forge_session=${createSession(app.db, member.value.id).token}`;
    const got = await fetch(`${base}/api/v1/admin/requests`, { headers: { cookie } });
    // The admin gate answers a member before the handler does; anonymous gets 404.
    expect(got.status).toBe(403);
    expect(await got.text()).not.toContain("guest2");
    expect((await fetch(`${base}/api/v1/admin/requests`)).status).toBe(404);
    const post = await fetch(`${base}/api/v1/admin/requests/guest2/allow`, { method: "POST", headers: { cookie, origin: ORIGIN } });
    expect([403, 404]).toContain(post.status);
    expect(getUserByName(app.db, "guest2")?.waitingAt).not.toBeNull();
  });
});

describe("the terminal answers requests", () => {
  const open = (username: string) => {
    const user = getUserByName(app.db, username)!;
    const { app: tui } = createForgeApp(app, { sshUsername: "t", remoteAddress: "127.0.0.1", user }, { terminal: headlessTerminal(140, 32), exitHooks: false });
    tui.start();
    const k = (key: string, ctrl = false) => tui.dispatch({ type: "key", key, ctrl, alt: false, shift: false });
    return {
      text: () => tui.screen.toText(),
      press: async (...keys: string[]) => {
        keys.forEach((x) => k(x));
        await settleApp(tui);
      },
      palette: async () => {
        k("k", true);
        for (const ch of "Waiting") k(ch);
        k("enter");
        await settleApp(tui);
      },
      stop: () => tui.stop(),
    };
  };

  test("Allow and Decline on the selected row, through the same action", async () => {
    clearFill();
    app.db.query("DELETE FROM account_request WHERE state = 'waiting'").run();
    expect((await api("tuia")).status).toBe(202);
    expect((await api("tuib")).status).toBe(202);
    const h = open("ada");
    await h.palette();
    expect(h.text()).toContain("tuia");
    expect(h.text()).toContain("tuib");
    await h.press("a");
    expect(h.text()).toContain("tuia is in.");
    expect(getUserByName(app.db, "tuia")?.waitingAt).toBeNull();
    await h.press("d");
    expect(h.text()).toContain("tuib was declined");
    expect(getUserByName(app.db, "tuib")?.waitingAt).not.toBeNull();
    expect(waitingCount(app.db)).toBe(0);
    h.stop();
  });

  test("a non-admin is offered no Waiting screen", async () => {
    const h = open("plain");
    await h.palette();
    expect(h.text()).not.toContain("strangers who asked");
    h.stop();
  });
});
