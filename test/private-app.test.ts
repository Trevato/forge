/**
 * A private app stays private when its repository is public (#620).
 * Reading the code is not a key: a private app, each of its previews, its
 * terminal and its identity hand-off answer only to people who can write
 * the repository and to its crew. A signed-in stranger who can read the
 * repository, and an anonymous visitor, reach none of it — and making the
 * repository public changes nobody's admission.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { newApp, openEnvUrl } from "../src/actions/apps.ts";
import { updateRepoSettings } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { grantUrl } from "../src/apps/proxy.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { runAppTty, type TtyHost } from "../src/apps/tty.ts";
import type { AppRecord } from "../src/core/apps.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";

describe("a private app on a public repository stays private", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let carol: User;
  let bot: User;
  let record: AppRecord;
  let carolCookie = "";
  let aliceCookie = "";

  const repo = (): Repo => getRepoById(app.db, record.repoId)!;

  const signIn = async (username: string): Promise<string> => {
    const response = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
      redirect: "manual",
    });
    return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-private-app-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    await runtime.start();
    const people: User[] = [];
    for (const [username, first] of [
      ["alice", true],
      ["carol", false],
    ] as const) {
      const made = await createUser(app.db, { trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
      people.push(made.value);
    }
    [alice, carol] = people as [User, User];
    const agent = await createAgent(app, alice, { username: "bot" });
    if (!agent.ok) throw new Error(String(agent.error));
    bot = agent.value.user;
    // A private repository with a private app: the case that holds today.
    const made = await newApp(app, alice, {
      name: "ledger",
      description: "Books",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    record = made.value.app;
    expect(record.access).toBe("private");
    expect(addToCrew(app, alice, repo(), "bot").ok).toBe(true);
    aliceCookie = await signIn("alice");
    carolCookie = await signIn("carol");
  }, 120_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const makePublic = async () => {
    const changed = await updateRepoSettings(app, alice, repo(), {
      visibility: "public",
    });
    expect(changed.ok).toBe(true);
    expect(repo().visibility).toBe("public");
  };

  const ttyHost: TtyHost = {
    cols: 80,
    rows: 24,
    term: undefined,
    write() {},
    onData() {},
    onResize() {},
  };

  /** Ask the app host for `/` as a script would, carrying `cookie`. */
  const knock = (host: string, cookie = "") =>
    fetch(`${servers.url}/`, {
      headers: {
        host,
        accept: "application/json",
        ...(cookie ? { cookie } : {}),
      },
      redirect: "manual",
    });

  /** The grant cookie a signed grant URL sets on the app host. */
  const cookieFrom = async (link: string): Promise<string> => {
    const url = new URL(link);
    const res = await fetch(`${servers.url}${url.pathname}${url.search}`, {
      headers: { host: url.host },
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };

  test("the repository turns public; no app admission changes", async () => {
    await makePublic();
    expect(getRepoById(app.db, record.repoId)!.visibility).toBe("public");
  });

  test("a signed-in reader is refused the app and every preview; writers and the crew are not", () => {
    for (const env of ["production", "pull-1", "pull-7"]) {
      const stranger = openEnvUrl(app, carol, repo(), env);
      expect(stranger.ok).toBe(false);
      if (!stranger.ok) expect(stranger.error).toBe("not_found");
      expect(openEnvUrl(app, alice, repo(), env).ok).toBe(true);
      expect(openEnvUrl(app, bot, repo(), env).ok).toBe(true);
    }
    const anonymous = openEnvUrl(app, undefined, repo(), "production");
    expect(anonymous.ok).toBe(false);
  });

  test("the identity hand-off refuses a reader and serves a writer", async () => {
    const host = `ledger.${DOMAIN}`;
    const open = (cookie: string, to = host) =>
      fetch(`${servers.url}/apps/open?host=${encodeURIComponent(to)}&to=%2F`, {
        headers: { cookie },
        redirect: "manual",
      });
    expect((await open(carolCookie)).status).toBe(404);
    expect((await open(carolCookie, `ledger--3.${DOMAIN}`)).status).toBe(404);
    const writer = await open(aliceCookie);
    expect(writer.status).toBe(302);
    expect(new URL(writer.headers.get("location")!).pathname).toBe(
      "/__forge/grant",
    );
    // The API's door answers the same.
    const api = await fetch(
      `${servers.url}/api/v1/repos/alice/ledger/app/production/open`,
      { headers: { cookie: carolCookie } },
    );
    expect(api.status).toBe(404);
  });

  test("a grant a reader already holds stops working; a writer's keeps working", async () => {
    const target = { app: record, env: "production" as const };
    const host = `ledger.${DOMAIN}`;
    const carols = await cookieFrom(
      grantUrl(runtime, target, "/", host, {
        id: carol.id,
        name: carol.username,
        role: "user",
      }),
    );
    expect(carols).not.toBe("");
    expect((await knock(host, carols)).status).toBe(404);
    const alices = await cookieFrom(
      grantUrl(runtime, target, "/", host, {
        id: alice.id,
        name: alice.username,
        role: "admin",
      }),
    );
    expect((await knock(host, alices)).status).not.toBe(404);
    // Nobody named, nothing granted.
    expect((await knock(host)).status).toBe(404);
  });

  test("the same holds for a preview's host", async () => {
    const target = { app: record, env: "pull-2" as const };
    const host = `ledger--2.${DOMAIN}`;
    const grantFor = (who: User, role: "user" | "admin") =>
      cookieFrom(
        grantUrl(runtime, target, "/", host, {
          id: who.id,
          name: who.username,
          role,
        }),
      );
    // A person navigating who is not let in is sent to sign in (303); one
    // let in reaches the preview, here one with no deploy (not a 303).
    const page = (cookie: string) =>
      fetch(`${servers.url}/`, {
        headers: { host, accept: "text/html", cookie },
        redirect: "manual",
      });
    expect((await page(await grantFor(carol, "user"))).status).toBe(303);
    expect((await page(await grantFor(alice, "admin"))).status).not.toBe(303);
  });

  test("the terminal refuses a reader and an anonymous visitor; a writer and the crew get through", async () => {
    const target = { app: record, env: "production" as const };
    const stranger = await runAppTty(app, ttyHost, carol, target);
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.error.refusal).toBe("not_found");
    const nobody = await runAppTty(app, ttyHost, undefined, target);
    expect(nobody.ok).toBe(false);
    if (!nobody.ok)
      expect(["private", "not_found"]).toContain(nobody.error.refusal);
    // Past the door, these two fail only for want of a terminal here.
    for (const who of [alice, bot]) {
      const through = await runAppTty(app, ttyHost, who, target);
      expect(through.ok).toBe(false);
      if (!through.ok) expect(through.error.refusal).toBe("no_pty");
    }
  });

  test("the settings page says, before saving, what stays private", async () => {
    const page = await fetch(`${servers.url}/alice/ledger/settings`, {
      headers: { cookie: `${aliceCookie}; forge_mode=dev` },
    });
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain("run logs");
    expect(text).toContain("stay open only to people who can write here");
    const appSettings = await fetch(
      `${servers.url}/alice/ledger/settings/app`,
      { headers: { cookie: `${aliceCookie}; forge_mode=dev` } },
    );
    expect(await appSettings.text()).toContain(
      "Private — people who can write this repository",
    );
  });
});
