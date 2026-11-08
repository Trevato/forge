/**
 * A connect in flight goes on only to the authorize URL sealed on its flow.
 *
 * The flow page used to take that URL from its own query string (`?to=`),
 * checked only for the instance's origin and a PKCE challenge: a crafted
 * link could pick another application's client id or another callback on
 * the same instance. Now the page reads the URL the flow was started with,
 * checks it again (path, client id, callback, challenge), and refuses a `to`
 * that is not exactly that URL. A flow past its time says so, with a fresh
 * Connect, instead of sending anyone to a consent screen for a dead state.
 */

import { everyoneIsAMember } from "./helpers/members.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { registerOriginApp } from "../src/actions/origins.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { flowTarget } from "../src/origins/oauth.ts";
import { quietLogs, withoutEnv } from "./helpers/globals.ts";
import {
  newFakeOAuth,
  newFakeState,
  serveFakeForge,
  type FakeForge,
} from "./fake-origin.ts";

quietLogs();
withoutEnv("FORGE_URL");

const CLIENT_ID = "forge-flow-page-client";

describe("the connect flow page", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let fake: FakeForge;
  let user: User;
  let cookie = "";

  const browse = (path: string, form?: Record<string, string>) =>
    fetch(`${servers.url}${path}`, {
      method: form === undefined ? "GET" : "POST",
      headers: {
        cookie,
        ...(form === undefined ? {} : { origin: new URL(servers.url).origin }),
      },
      redirect: "manual",
      ...(form === undefined ? {} : { body: new URLSearchParams(form) }),
    });

  /** Start a code flow from Settings → Origins: its page, and its id. */
  const start = async (): Promise<{ page: string; id: string }> => {
    const started = await browse("/settings/origins/oauth", { host: fake.url });
    expect(started.status).toBe(303);
    const page = started.headers.get("location")!;
    expect(page).toStartWith("/settings/origins/flows/");
    return { page, id: page.split("/").at(-1)!.split("?")[0]! };
  };

  const continueTo = (html: string): string | undefined =>
    /href="([^"]*\/login\/oauth\/authorize[^"]*)"/.exec(html)?.[1]?.replaceAll("&amp;", "&");

  beforeAll(async () => {
    const state = newFakeState("forgejo", "octo", "octo-flow-page-token");
    state.oauth = newFakeOAuth(CLIENT_ID);
    fake = serveFakeForge(state);
    dir = await mkdtemp(join(tmpdir(), "forge-flow-page-"));
    app = createApp({ dataDir: dir, port: 0 });
    everyoneIsAMember(app.db);
    servers = await serve(app);
    const made = await createUser(app.db, {
      username: "ada",
      email: "ada@forge.test",
      password: "a-long-flow-page-passphrase",
      origin: "seed",
      trusted: true,
    });
    if (!made.ok) throw new Error(made.error);
    user = made.value;
    cookie = `forge_session=${createSession(app.db, user.id).token}`;
    const registered = await registerOriginApp(app, user, {
      host: fake.url,
      clientId: CLIENT_ID,
    });
    if (!registered.ok) throw new Error(registered.error);
  });

  afterAll(async () => {
    fake.stop();
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the redirect carries no URL; the page links to the one stored on the flow", async () => {
    const { page, id } = await start();
    expect(page).not.toContain("to=");
    const stored = flowTarget(app.db, dir, id)!;
    const url = new URL(stored);
    expect(url.pathname).toBe("/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(continueTo(await (await browse(page)).text())).toBe(stored);
  });

  test("a crafted `to` for another application on the same instance is refused", async () => {
    const { page, id } = await start();
    const crafted = new URL(flowTarget(app.db, dir, id)!);
    crafted.searchParams.set("client_id", "someone-elses-client");
    const html = await (
      await browse(`${page}?to=${encodeURIComponent(crafted.toString())}`)
    ).text();
    expect(continueTo(html)).toBeUndefined();
    expect(html).not.toContain("someone-elses-client");
    expect(html).toContain("cannot be continued from here");
  });

  test("a crafted `to` with another callback is refused too; the exact stored URL still goes on", async () => {
    const { page, id } = await start();
    const stored = flowTarget(app.db, dir, id)!;
    const elsewhere = new URL(stored);
    elsewhere.searchParams.set("redirect_uri", "https://evil.example/callback");
    const refused = await (
      await browse(`${page}?to=${encodeURIComponent(elsewhere.toString())}`)
    ).text();
    expect(continueTo(refused)).toBeUndefined();
    const exact = await (await browse(`${page}?to=${encodeURIComponent(stored)}`)).text();
    expect(continueTo(exact)).toBe(stored);
  });

  test("an expired flow is refused, with a fresh Connect in its place", async () => {
    const { page, id } = await start();
    app.db
      .query("UPDATE oauth_flow SET expires_at = ?1 WHERE id = ?2")
      .run(new Date(Date.now() - 60_000).toISOString(), id);
    const html = await (await browse(page)).text();
    expect(html).toContain("This connect link expired");
    expect(continueTo(html)).toBeUndefined();
    expect(html).toContain('action="/settings/origins/oauth"');
    expect(html).toContain(`value="${fake.url}"`);
  });

  test("a connect started from migrate carries only `then`, and its expired page starts again from there", async () => {
    const started = await browse("/settings/origins/oauth", {
      host: fake.url,
      then: "migrate",
    });
    expect(started.status).toBe(303);
    const page = started.headers.get("location")!;
    expect(page).toEndWith("?then=migrate");
    expect(page).not.toContain("to=");
    const id = page.split("/").at(-1)!.split("?")[0]!;
    expect(continueTo(await (await browse(page)).text())).toBe(
      flowTarget(app.db, dir, id)!,
    );
    app.db
      .query("UPDATE oauth_flow SET expires_at = ?1 WHERE id = ?2")
      .run(new Date(Date.now() - 60_000).toISOString(), id);
    const html = await (await browse(page)).text();
    expect(html).toContain("This connect link expired");
    expect(html).toContain('name="then" value="migrate"');
  });
});
