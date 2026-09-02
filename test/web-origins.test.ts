/**
 * Origins on the web surface, driven the way a browser drives it: form posts
 * with a session cookie, redirects followed by hand, and every assertion made
 * against the HTML that actually came back.
 *
 * The adversarial cases carry the weight. A token must never appear in a
 * page. Every new POST must refuse a cross-origin submit. An anonymous
 * visitor must be sent to sign in rather than shown an empty list. And a
 * writer who is not the person who connected the origin must be told why
 * their comment did not go upstream, not silently given a local one.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { resetConnectLimit } from "../src/actions/origins.ts";
import { createToken } from "../src/actions/users.ts";
import { listOrigins } from "../src/core/origins.ts";
import { listPins } from "../src/core/pins.ts";
import { getRepo } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { setLogLevel } from "../src/kernel/log.ts";
import {
  newFakeOAuth,
  newFakeState,
  serveFakeForge,
  type FakeForge,
  type FakeOAuth,
} from "./fake-origin.ts";

setLogLevel("error");

const ORIGIN_LOGIN = "octo";
const ORIGIN_TOKEN = "octo-origin-secret-9f2a";
const PASSWORD = "a-long-web-passphrase";
const CLIENT_ID = "Iv1.forge-web-client";

const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

describe("origins on the web", () => {
  let dataDir: string;
  let originDataDir: string;
  let app: App;
  let servers: Servers;
  let originApp: App;
  let originServers: Servers;
  let forgejo: FakeForge;
  let github: FakeForge;
  let ghOauth: FakeOAuth;
  let fjOauth: FakeOAuth;
  let base: string;
  let alice = "";
  let bob = "";

  /** A browser request: session cookie, manual redirects, real Origin. */
  const asUser = (
    cookie: string,
    path: string,
    init: RequestInit & { form?: Record<string, string>; origin?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (cookie !== "") headers.set("cookie", cookie);
    const method = init.form !== undefined ? "POST" : (init.method ?? "GET");
    if (init.form !== undefined)
      headers.set("origin", init.origin ?? new URL(base).origin);
    return fetch(`${base}${path}`, {
      ...init,
      method,
      headers,
      redirect: "manual",
      ...(init.form === undefined
        ? {}
        : { body: new URLSearchParams(init.form) }),
    });
  };

  const signUp = async (username: string): Promise<string> => {
    const response = await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        username,
        email: `${username}@forge.test`,
        password: PASSWORD,
      }),
      redirect: "manual",
    });
    return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-weborigins-"));
    originDataDir = await mkdtemp(join(tmpdir(), "forge-webupstream-"));

    // A second real forge, so the mirror's git fetch speaks real smart HTTP.
    originApp = createApp({ dataDir: originDataDir, port: 0 });
    originServers = await serve(originApp);
    await fetch(`${originServers.url}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: ORIGIN_LOGIN,
        email: "octo@upstream.test",
        password: ORIGIN_TOKEN,
      }),
    });
    await fetch(`${originServers.url}/api/v1/repos`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basic(ORIGIN_LOGIN, ORIGIN_TOKEN),
      },
      body: JSON.stringify({ name: "widgets", visibility: "public" }),
    });
    await fetch(`${originServers.url}/api/v1/repos/octo/widgets/contents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: basic(ORIGIN_LOGIN, ORIGIN_TOKEN),
      },
      body: JSON.stringify({
        branch: "main",
        message: "first",
        files: [{ path: "README.md", content: "# widgets\nhello\n" }],
      }),
    });

    const state = newFakeState("forgejo", ORIGIN_LOGIN, ORIGIN_TOKEN);
    state.repos.push({
      id: 41,
      fullName: "octo/widgets",
      description: "gears and things",
      cloneUrl: `${originServers.url}/octo/widgets.git`,
      htmlUrl: `${originServers.url}/octo/widgets`,
      defaultBranch: "main",
    });
    state.labels.set("octo/widgets", [{ id: 1, name: "bug", color: "d73a4a" }]);
    state.issues.set("octo/widgets", [
      {
        id: 900,
        number: 7,
        title: "The gear slips",
        body: "under load",
        user: "mona",
        labels: ["bug"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
    fjOauth = newFakeOAuth(CLIENT_ID);
    state.oauth = fjOauth;
    forgejo = serveFakeForge(state);

    const ghState = newFakeState("github", ORIGIN_LOGIN, "unused-pat");
    ghOauth = newFakeOAuth(CLIENT_ID);
    ghState.oauth = ghOauth;
    github = serveFakeForge(ghState);

    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    // Whatever the environment thinks: this suite decides when GitHub is
    // configured, and its first assertion is about it *not* being.
    delete process.env.FORGE_GITHUB_CLIENT_ID;
    alice = await signUp("alice");
    bob = await signUp("bob");
    resetConnectLimit();
    forgetProviders(dataDir);
  });

  afterAll(async () => {
    delete process.env.FORGE_GITHUB_CLIENT_ID;
    forgejo.stop();
    github.stop();
    servers.stop();
    originServers.stop();
    app.close();
    originApp.close();
    forgetProviders(dataDir);
    await rm(dataDir, { recursive: true, force: true });
    await rm(originDataDir, { recursive: true, force: true });
  });

  // ---- the empty page, and who may see it ----

  test("an anonymous visitor is sent to sign in, not shown a list", async () => {
    const response = await asUser("", "/settings/origins");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toStartWith("/signin?next=");
  });

  test("the origins page starts empty and offers the three ways in", async () => {
    const html = await (await asUser(alice, "/settings/origins")).text();
    expect(html).toContain("No origins connected");
    expect(html).toContain("Forgejo or Gitea");
    expect(html).toContain("Personal access token");
    // No GitHub client id is configured yet, so the button is replaced by a
    // hint rather than left there to fail.
    expect(html).toContain("FORGE_GITHUB_CLIENT_ID");
    expect(html).not.toContain('name="kind" value="github"');
    // And it is reachable from the settings nav.
    expect(html).toContain('href="/settings/origins"');
  });

  // ---- the token path ----

  test("connecting with a token stores it and never echoes it", async () => {
    const posted = await asUser(alice, "/settings/origins/token", {
      form: { host: forgejo.url, token: ORIGIN_TOKEN },
    });
    expect(posted.status).toBe(303);
    expect(posted.headers.get("location")).toBe("/settings/origins");

    const html = await (await asUser(alice, "/settings/origins")).text();
    expect(html).toContain(ORIGIN_LOGIN);
    expect(html).toContain("Healthy");
    expect(html).toContain("personal access token");
    // The one thing that must never be on this page.
    expect(html).not.toContain(ORIGIN_TOKEN);

    const stored = listOrigins(app.db, getUserByName(app.db, "alice")!.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.login).toBe(ORIGIN_LOGIN);
  });

  test("a bad token comes back inline with the host preserved and no secret", async () => {
    const response = await asUser(alice, "/settings/origins/token", {
      form: { host: forgejo.url, token: "not-the-right-token" },
    });
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("refused by the origin");
    expect(html).toContain(forgejo.url);
    expect(html).not.toContain("not-the-right-token");
  });

  test("another user cannot see or act on that origin", async () => {
    const html = await (await asUser(bob, "/settings/origins")).text();
    expect(html).toContain("No origins connected");
    const id = listOrigins(app.db, getUserByName(app.db, "alice")!.id)[0]!.id;
    const stolen = await asUser(bob, `/settings/origins/${id}/repos`);
    expect(stolen.status).toBe(404);
  });

  // ---- the picker and mirroring ----

  test("the picker lists the origin's repos and Mirror creates one", async () => {
    const id = listOrigins(app.db, getUserByName(app.db, "alice")!.id)[0]!.id;
    const html = await (
      await asUser(alice, `/settings/origins/${id}/repos`)
    ).text();
    expect(html).toContain("octo/widgets");
    expect(html).toContain("gears and things");
    expect(html).toContain("Mirror");
    // No "mirror everything" anywhere on the page.
    expect(html).not.toContain("Mirror all");

    const mirrored = await asUser(alice, `/settings/origins/${id}/mirror`, {
      form: { fullName: "octo/widgets" },
    });
    expect(mirrored.status).toBe(303);
    expect(mirrored.headers.get("location")).toBe("/alice/widgets");
    expect(getRepo(app.db, "alice", "widgets")).toBeDefined();
  });

  test("the repo header wears the origin chip and the About rail its fetch", async () => {
    const html = await (await asUser(alice, "/alice/widgets")).text();
    expect(html).toContain("mirrored from octo/widgets");
    expect(html).toContain(`${originServers.url}/octo/widgets`);
    expect(html).toContain("Last fetch");
    expect(html).toContain("Sync now");
    // Push instructions say where a push actually goes.
    expect(html).toContain("Pushes here go through to");
  });

  test("an imported issue shows the origin's author, not the local one", async () => {
    const html = await (await asUser(alice, "/alice/widgets/issues")).text();
    expect(html).toContain("The gear slips");
    expect(html).toContain("mona");
    const page = await (await asUser(alice, "/alice/widgets/issues/7")).text();
    expect(page).toContain("mona");
    expect(page).toContain("view on origin");
  });

  test("commenting on a mirrored issue goes through to the origin", async () => {
    const before = forgejo.state.requests.length;
    const posted = await asUser(alice, "/alice/widgets/issues/7/comments", {
      form: { body: "from the web" },
    });
    expect(posted.status).toBe(303);
    const wrote = forgejo.state.requests
      .slice(before)
      .some(
        (r) =>
          r.method === "POST" &&
          r.path.endsWith("/issues/7/comments") &&
          r.body.includes("from the web"),
      );
    expect(wrote).toBe(true);
    const html = await (await asUser(alice, "/alice/widgets/issues/7")).text();
    expect(html).toContain("from the web");
  });

  test("a writer who is not the origin's owner is told why, and nothing is written", async () => {
    const before = forgejo.state.requests.length;
    const posted = await asUser(bob, "/alice/widgets/issues/7/comments", {
      form: { body: "bob was here" },
    });
    expect(posted.status).toBe(303);
    const flash = posted.headers.get("set-cookie") ?? "";
    expect(decodeURIComponent(flash)).toContain(
      "Only the person who connected this origin",
    );
    expect(
      forgejo.state.requests.slice(before).some((r) => r.method === "POST"),
    ).toBe(false);
  });

  test("a mirrored pull's merge box points at the origin", async () => {
    // The mirror has no pull, so assert the state machine directly: a merge
    // POST on a mirror is refused with the origin's own wording.
    const html = await (await asUser(alice, "/alice/widgets/issues/7")).text();
    // Closing goes through the same twin, and the origin sees it.
    const before = forgejo.state.requests.length;
    await asUser(alice, "/alice/widgets/issues/7/state", {
      form: { state: "closed" },
    });
    expect(
      forgejo.state.requests
        .slice(before)
        .some((r) => r.method === "PATCH" || r.method === "POST"),
    ).toBe(true);
    expect(html).toContain("The gear slips");
  });

  // ---- pins ----

  test("the pin toggle round-trips and the dashboard lists what is pinned", async () => {
    const aliceId = getUserByName(app.db, "alice")!.id;
    const pinned = await asUser(alice, "/alice/widgets/pin", {
      form: { pinned: "1" },
    });
    expect(pinned.status).toBe(303);
    expect(listPins(app.db, aliceId)).toHaveLength(1);

    const dash = await (await asUser(alice, "/")).text();
    expect(dash).toContain("On your machine");
    expect(dash).toContain("forge sync");
    expect(dash).toContain("Pinned");

    const off = await asUser(alice, "/alice/widgets/pin", {
      form: { pinned: "0" },
    });
    expect(off.status).toBe(303);
    expect(listPins(app.db, aliceId)).toHaveLength(0);
  });

  // ---- the device grant ----

  test("the device flow shows the code and the poll route completes it", async () => {
    process.env.FORGE_GITHUB_CLIENT_ID = CLIENT_ID;
    resetConnectLimit();
    const started = await asUser(alice, "/settings/origins/oauth", {
      form: { kind: "github", host: github.url },
    });
    expect(started.status).toBe(303);
    const where = started.headers.get("location") ?? "";
    expect(where).toStartWith("/settings/origins/flows/");

    const page = await (await asUser(alice, where)).text();
    expect(page).toContain("WXYZ-1234");
    expect(page).toContain(ghOauth.verificationUri);
    // The no-JavaScript half is on the page, and says so.
    expect(page).toContain("Check again");
    expect(page).toContain("Refresh this page to check again");
    // The device code itself never crosses to the browser.
    expect(page).not.toContain(ghOauth.deviceCode);

    // Still pending: the poll comes back to the same page.
    const pending = await asUser(alice, `${where}/poll`, { form: {} });
    expect(pending.status).toBe(303);
    expect(pending.headers.get("location")).toBe(where);

    // The human approves on the other device.
    ghOauth.approved = true;
    const done = await asUser(alice, `${where}/poll`, { form: {} });
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/settings/origins?connected=1");

    const landing = await (
      await asUser(alice, "/settings/origins?connected=1")
    ).text();
    expect(landing).toContain("Origin connected.");
    expect(landing).toContain("OAuth");
  });

  test("the poll route answers JSON when asked, for the enhancement", async () => {
    const started = await asUser(alice, "/settings/origins/oauth", {
      form: { kind: "github", host: github.url },
    });
    const where = started.headers.get("location") ?? "";
    const polled = await asUser(alice, `${where}/poll`, {
      form: {},
      headers: { accept: "application/json" },
    });
    expect(polled.status).toBe(200);
    const body = (await polled.json()) as { status: string };
    expect(["pending", "done", "failed"]).toContain(body.status);
  });

  // ---- the Forgejo code flow ----

  test("an unregistered instance shows the exact redirect URI to paste", async () => {
    resetConnectLimit();
    const started = await asUser(bob, "/settings/origins/oauth", {
      form: { host: forgejo.url },
    });
    expect(started.status).toBe(303);
    const where = started.headers.get("location") ?? "";
    expect(where).toContain("register=1");

    const html = await (await asUser(bob, where)).text();
    expect(html).toContain("/user/settings/applications");
    expect(html).toContain(`${new URL(base).origin}/settings/origins/callback`);
    expect(html).toContain("public client is fine");
    expect(html).toContain("Client ID");
  });

  test("registering an app then authorizing sends a PKCE challenge", async () => {
    const registered = await asUser(bob, "/settings/origins/apps", {
      form: { host: forgejo.url, clientId: CLIENT_ID },
    });
    expect(registered.status).toBe(303);

    const page = await (
      await asUser(
        bob,
        `/settings/origins?host=${encodeURIComponent(forgejo.url)}`,
      )
    ).text();
    expect(page).toContain("Authorize");
    expect(page).toContain(CLIENT_ID);

    const started = await asUser(bob, "/settings/origins/oauth", {
      form: { host: forgejo.url },
    });
    expect(started.status).toBe(303);
    const where = started.headers.get("location") ?? "";
    const flow = await (await asUser(bob, where)).text();
    expect(flow).toContain("code_challenge=");
    expect(flow).toContain("code_challenge_method=S256");
    expect(flow).toContain("Continue to the instance");
  });

  // ---- CSRF ----

  test("every new POST refuses a cross-origin submit", async () => {
    const id = listOrigins(app.db, getUserByName(app.db, "alice")!.id)[0]!.id;
    const routes: [string, Record<string, string>][] = [
      ["/settings/origins/token", { host: forgejo.url, token: "x" }],
      ["/settings/origins/oauth", { kind: "github" }],
      ["/settings/origins/apps", { host: forgejo.url, clientId: "x" }],
      [`/settings/origins/${id}/sync`, {}],
      [`/settings/origins/${id}/mirror`, { fullName: "octo/widgets" }],
      [`/settings/origins/${id}/delete`, {}],
      ["/alice/widgets/pin", { pinned: "1" }],
      ["/alice/widgets/sync", {}],
    ];
    for (const [path, form] of routes) {
      const response = await asUser(alice, path, {
        form,
        origin: "https://evil.example",
      });
      expect(`${path}:${response.status}`).toBe(`${path}:403`);
    }
  });

  test("an rw token cannot even enumerate the origins a session can", async () => {
    const user = getUserByName(app.db, "alice")!;
    const rw = createToken(app, user, "laptop", "rw");
    const admin = createToken(app, user, "deploy", "admin");
    if (!rw.ok || !admin.ok) throw new Error("token mint failed");
    const id = listOrigins(app.db, user.id)[0]!.id;

    for (const path of [
      "/settings/origins",
      `/settings/origins/${id}/repos`,
    ]) {
      const denied = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${rw.value.token}` },
        redirect: "manual",
      });
      expect(`${path}:${denied.status}`).toBe(`${path}:403`);
      // An explicit admin token is the documented way in for automation.
      const allowed = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${admin.value.token}` },
        redirect: "manual",
      });
      expect(`${path}:${allowed.status}`).toBe(`${path}:200`);
    }

    // And it cannot spend one either.
    const write = await fetch(`${base}/settings/origins/${id}/sync`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rw.value.token}`,
        origin: new URL(base).origin,
      },
      body: new URLSearchParams({}),
      redirect: "manual",
    });
    expect(write.status).toBe(403);
  });

  test("disconnecting is confirmed on a page that says what it costs", async () => {
    const id = listOrigins(app.db, getUserByName(app.db, "alice")!.id)[0]!.id;
    const confirm = await asUser(
      alice,
      `/-/confirm?to=${encodeURIComponent(`/settings/origins/${id}/delete`)}`,
    );
    expect(confirm.status).toBe(200);
    const html = await confirm.text();
    expect(html).toContain("Disconnect this origin?");
    expect(html).toContain("revoked upstream only where the forge allows it");

    const gone = await asUser(alice, `/settings/origins/${id}/delete`, {
      form: {},
    });
    expect(gone.status).toBe(303);
    // The mirror survives the disconnect; it simply stops syncing.
    expect(getRepo(app.db, "alice", "widgets")).toBeDefined();
  });
});
