import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { createSession, listSessions } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const EDGE = "edge-secret-for-signins";

// Where an account is signed in: its person sees and ends their own, the
// forge's owner any person's. Everyone else finds nothing there.
describe("sign-ins: tokens and browsers, seen and ended", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let owner: User;
  let ada: User;
  let bo: User;
  let other: User;

  const person = async (username: string, isAdmin = false) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@f.dev`,
      password: "a-good-passphrase",
      adminIfFirst: isAdmin,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const cookieFor = (user: User) =>
    `forge_session=${createSession(app.db, user.id).token}`;
  const signedIn = async (auth: { cookie?: string; token?: string }) =>
    (
      await fetch(`${base}/api/v1/user`, {
        headers: auth.cookie
          ? { cookie: auth.cookie }
          : { authorization: `Bearer ${auth.token}` },
      })
    ).status === 200;
  const post = (path: string, cookie: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({}),
      redirect: "manual",
    });
  const api = (path: string, token: string, method = "GET") =>
    fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
    });
  const sessionIds = (user: User) =>
    listSessions(app.db, user.id).map((s) => s.id);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-signins-"));
    app = createApp({ dataDir, port: 0, edgeToken: EDGE });
    servers = await serve(app);
    base = servers.url;
    owner = await person("olive", true);
    ada = await person("ada");
    bo = await person("bo");
    other = await person("hal");
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(other.id);
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a person sees their own browsers, this one marked, and signs another out", async () => {
    const here = cookieFor(ada);
    const there = cookieFor(ada);
    const page = await (
      await fetch(`${base}/settings/tokens`, { headers: { cookie: here } })
    ).text();
    expect(page).toContain("Signed-in browsers");
    expect(page).toContain("This browser");
    expect(page.match(/%2Fsettings%2Fsessions%2F[^%"]+%2Fdelete/g)?.length).toBe(2);
    expect(await signedIn({ cookie: there })).toBe(true);

    const mine = listSessions(app.db, ada.id, here.split("=")[1]);
    const away = mine.find((s) => !s.current)!;
    const res = await post(`/settings/sessions/${away.id}/delete`, here);
    expect(res.status).toBe(303);
    // The browser signed out is signed out on its very next request.
    expect(await signedIn({ cookie: there })).toBe(false);
    expect(await signedIn({ cookie: here })).toBe(true);
  });

  test("signing a browser out ends the live streams it opened, and only those", async () => {
    const here = cookieFor(ada);
    const there = cookieFor(ada);
    const open = async (cookie: string) => {
      const res = await fetch(`${base}/events`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      await reader.read();
      return reader;
    };
    const away = await open(there);
    const kept = await open(here);
    const id = listSessions(app.db, ada.id, there.split("=")[1]).find(
      (s) => s.current,
    )!.id;
    expect((await post(`/settings/sessions/${id}/delete`, here)).status).toBe(303);
    const ended = (async () => {
      for (;;) if ((await away.read()).done) return true;
    })();
    expect(
      await Promise.race([ended, Bun.sleep(5_000).then(() => false)]),
    ).toBe(true);
    const still = await Promise.race([
      kept.read().then((r) => (r.done ? "ended" : "data")),
      Bun.sleep(500).then(() => "open"),
    ]);
    expect(still).not.toBe("ended");
    await kept.cancel();
  });

  test("signing out from the page ends every stream that browser holds, in every tab", async () => {
    const cookie = cookieFor(ada);
    const elsewhere = cookieFor(ada);
    const open = async (c: string) => {
      const res = await fetch(`${base}/events`, { headers: { cookie: c } });
      const reader = res.body!.getReader();
      await reader.read();
      return reader;
    };
    const tabs = [await open(cookie), await open(cookie)];
    const other = await open(elsewhere);
    expect((await post("/logout", cookie)).status).toBe(303);
    for (const tab of tabs) {
      const ended = (async () => {
        for (;;) if ((await tab.read()).done) return true;
      })();
      expect(
        await Promise.race([ended, Bun.sleep(5_000).then(() => false)]),
      ).toBe(true);
    }
    expect(await signedIn({ cookie })).toBe(false);
    // The account's other browser was not the one that signed out.
    const still = await Promise.race([
      other.read().then((r) => (r.done ? "ended" : "data")),
      Bun.sleep(500).then(() => "open"),
    ]);
    expect(still).not.toBe("ended");
    expect(await signedIn({ cookie: elsewhere })).toBe(true);
    await other.cancel();
  });

  test("signing out while the platform edge also signs the request in still ends the browser's streams", async () => {
    const cookie = cookieFor(ada);
    const res = await fetch(`${base}/events`, { headers: { cookie } });
    const tab = res.body!.getReader();
    await tab.read();
    // The edge goes first, so this request is the edge's, not the cookie's.
    const out = await fetch(`${base}/logout`, {
      method: "POST",
      headers: {
        cookie,
        origin: base,
        "x-plat-user": "ada",
        "x-plat-edge-token": EDGE,
      },
      body: new URLSearchParams({}),
      redirect: "manual",
    });
    expect(out.status).toBe(303);
    const ended = (async () => {
      for (;;) if ((await tab.read()).done) return true;
    })();
    expect(
      await Promise.race([ended, Bun.sleep(5_000).then(() => false)]),
    ).toBe(true);
    expect(await signedIn({ cookie })).toBe(false);
  });

  test("a browser's last-seen time moves when it is used", async () => {
    const cookie = cookieFor(bo);
    expect(listSessions(app.db, bo.id)[0]!.lastSeenAt).toBeNull();
    expect(await signedIn({ cookie })).toBe(true);
    expect(listSessions(app.db, bo.id)[0]!.lastSeenAt).not.toBeNull();
  });

  test("nobody signs out a browser that is not theirs through their own settings", async () => {
    const victim = cookieFor(bo);
    const id = sessionIds(bo).at(-1)!;
    const res = await post(`/settings/sessions/${id}/delete`, cookieFor(ada));
    expect(res.status).toBe(303);
    expect(await signedIn({ cookie: victim })).toBe(true);
    expect(sessionIds(bo)).toContain(id);
  });

  test("a non-owner gets not_found for anyone else's sign-ins, by every route", async () => {
    const victimToken = createToken(app.db, bo.id, "laptop", "rw");
    const victim = cookieFor(bo);
    const id = sessionIds(bo)[0]!;
    const adaToken = createToken(app.db, ada.id, "a", "admin").token;
    expect((await api("/api/v1/users/bo/signins", adaToken)).status).toBe(404);
    expect(
      (await api(`/api/v1/users/bo/sessions/${id}`, adaToken, "DELETE")).status,
    ).toBe(404);
    const adaCookie = cookieFor(ada);
    expect(
      (await fetch(`${base}/settings/accounts/bo`, { headers: { cookie: adaCookie } }))
        .status,
    ).toBe(404);
    expect(
      (await post(`/settings/accounts/bo/tokens/${victimToken.id}/delete`, adaCookie))
        .status,
    ).toBe(404);
    expect(
      (await post(`/settings/accounts/bo/sessions/${id}/delete`, adaCookie)).status,
    ).toBe(404);
    // Strangers too.
    expect(
      (await fetch(`${base}/api/v1/users/bo/signins`)).status,
    ).toBe(401);
    expect(await signedIn({ token: victimToken.token })).toBe(true);
    expect(await signedIn({ cookie: victim })).toBe(true);
  });

  test("a token without admin scope cannot list or end sign-ins, even its own", async () => {
    const rw = createToken(app.db, ada.id, "ci", "rw").token;
    expect((await api("/api/v1/users/ada/signins", rw)).status).toBe(403);
  });

  test("the owner's page for a person lists their tokens and browsers, and revokes each", async () => {
    const token = createToken(app.db, bo.id, "deploy box", "rw");
    const browser = cookieFor(bo);
    const ownerCookie = cookieFor(owner);
    const list = await (
      await fetch(`${base}/settings/accounts`, { headers: { cookie: ownerCookie } })
    ).text();
    expect(list).toContain('href="/settings/accounts/bo"');
    const page = await (
      await fetch(`${base}/settings/accounts/bo`, { headers: { cookie: ownerCookie } })
    ).text();
    expect(page).toContain("deploy box");
    expect(page).toContain("Signed-in browsers");
    expect(page).not.toContain("This browser");

    const revoked = await post(
      `/settings/accounts/bo/tokens/${token.id}/delete`,
      ownerCookie,
    );
    expect(revoked.status).toBe(303);
    expect(await signedIn({ token: token.token })).toBe(false);

    const id = listSessions(app.db, bo.id, browser.split("=")[1]).find(
      (s) => s.current,
    )!.id;
    const ended = await post(`/settings/accounts/bo/sessions/${id}/delete`, ownerCookie);
    expect(ended.status).toBe(303);
    expect(await signedIn({ cookie: browser })).toBe(false);

    const audit = listEvents(app.db, { kind: "account.signed_out" });
    expect(audit.map((e) => e.payload["what"]).sort()).toEqual(["session", "token"]);
    expect(audit.every((e) => e.actorId === owner.id)).toBe(true);
  });

  // Revoking another account's token over the API is #781's
  // `DELETE /api/v1/users/:username/tokens/:id`; this pull adds the browsers.
  test("the owner does the same over the API, with an admin token", async () => {
    const ownerToken = createToken(app.db, owner.id, "o", "admin").token;
    createToken(app.db, bo.id, "phone", "ro");
    const browser = cookieFor(bo);
    const seen = (await (await api("/api/v1/users/bo/signins", ownerToken)).json()) as {
      tokens: { id: string; name: string }[];
      sessions: { id: string; current: boolean }[];
    };
    expect(seen.tokens.map((t) => t.name)).toContain("phone");
    expect(JSON.stringify(seen)).not.toContain(browser.split("=")[1]!);
    for (const s of seen.sessions)
      expect(
        (await api(`/api/v1/users/bo/sessions/${s.id}`, ownerToken, "DELETE")).status,
      ).toBe(204);
    expect(await signedIn({ cookie: browser })).toBe(false);
  });

  // The account page now opens for another admin, for the forge's owner alone, to reset their
  // access (#11688); the list of their tokens and browsers stays closed.
  test("the owner has no sign-ins list for another admin", async () => {
    const ownerToken = createToken(app.db, owner.id, "o2", "admin").token;
    expect((await api("/api/v1/users/hal/signins", ownerToken)).status).toBe(404);
    const page = await fetch(`${base}/settings/accounts/hal`, { headers: { cookie: cookieFor(owner) } });
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).not.toContain("Access tokens");
    expect(text).not.toContain("Signed-in browsers");
  });
});
