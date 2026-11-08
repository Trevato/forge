/**
 * The people a private app names (#752). A named person enters the app and
 * its previews — on a public repository and on a private one — and gets
 * nothing else: not the code, not the crew, not the owner's facts, not the
 * settings, not the terminal. A reader who is not named does not enter. Only
 * a person who can write the repository changes the list — never an agent,
 * never a reader — and a change is planned unless asked for. Removing a name,
 * or suspending the account, ends a grant already issued.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setAppMembersThrough } from "../src/actions/app_members.ts";
import { newApp, openEnvUrl } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { updateRepoSettings } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { grantUrl, readGrant } from "../src/apps/proxy.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { runAppTty, type TtyHost } from "../src/apps/tty.ts";
import type { AppRecord } from "../src/core/apps.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";

describe("a private app names the people who may enter it", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let carol: User;
  let dave: User;
  let bot: User;
  /** A public repository with a private app: the owner's game. */
  let game: AppRecord;
  /** A private repository with a private app. */
  let vault: AppRecord;
  const cookies: Record<string, string> = {};
  const tokens: Record<string, string> = {};

  const repoOf = (record: AppRecord): Repo =>
    getRepoById(app.db, record.repoId)!;

  const signIn = async (username: string): Promise<string> => {
    const response = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
      redirect: "manual",
    });
    return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  const api = (
    method: string,
    path: string,
    token: string | undefined,
    body?: unknown,
  ) =>
    fetch(`${servers.url}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const mcp = async (token: string, name: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text }
      : { value: JSON.parse(text) };
  };

  /** Ask an app host for `/` as a script would, carrying `cookie`. */
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

  const opens = (cookie: string, host: string) =>
    fetch(`${servers.url}/apps/open?host=${encodeURIComponent(host)}&to=%2F`, {
      headers: { cookie },
      redirect: "manual",
    });

  const name = (members: string[], record = game) =>
    setAppMembersThrough(app, alice, repoOf(record), {
      members,
      dryRun: false,
    });

  const ttyHost: TtyHost = {
    cols: 80,
    rows: 24,
    term: undefined,
    write() {},
    onData() {},
    onResize() {},
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-members-"));
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
      ["dave", false],
    ] as const) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
      people.push(made.value);
    }
    [alice, carol, dave] = people as [User, User, User];
    const agent = await createAgent(app, alice, { username: "bot" });
    if (!agent.ok) throw new Error(String(agent.error));
    bot = agent.value.user;
    const madeGame = await newApp(app, alice, {
      name: "game",
      description: "Friends play here",
      visibility: "private",
    });
    if (!madeGame.ok) throw new Error(String(madeGame.error));
    game = madeGame.value.app;
    expect(
      (
        await updateRepoSettings(app, alice, repoOf(game), {
          visibility: "public",
        })
      ).ok,
    ).toBe(true);
    expect(game.access).toBe("private");
    const madeVault = await newApp(app, alice, {
      name: "vault",
      description: "Private all through",
      visibility: "private",
    });
    if (!madeVault.ok) throw new Error(String(madeVault.error));
    vault = madeVault.value.app;
    expect(addToCrew(app, alice, repoOf(game), "bot").ok).toBe(true);
    for (const who of ["alice", "carol", "dave"])
      cookies[who] = await signIn(who);
    tokens["alice"] = createToken(app.db, alice.id, "admin", "admin").token;
    tokens["dave"] = createToken(app.db, dave.id, "admin", "admin").token;
    tokens["carol"] = createToken(app.db, carol.id, "rw", "rw").token;
    tokens["bot"] = createToken(app.db, bot.id, "rw", "rw").token;
  }, 120_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("before anyone is named, a reader is refused the app and its previews", async () => {
    for (const env of ["production", "pull-4"])
      expect(openEnvUrl(app, carol, repoOf(game), env).ok).toBe(false);
    expect((await opens(cookies["carol"]!, `game.${DOMAIN}`)).status).toBe(404);
  });

  test("an agent, a reader and a stranger cannot name anyone — on the action, the API and MCP", async () => {
    // The agent is on the crew and enters the app; it still chooses nobody.
    const byAgent = setAppMembersThrough(app, bot, repoOf(game), {
      members: ["carol"],
      dryRun: false,
    });
    expect(byAgent.ok).toBe(false);
    if (!byAgent.ok) expect(byAgent.error.kind).toBe("forbidden");
    const agentTool = await mcp(tokens["bot"]!, "app_members", {
      repo: "alice/game",
      members: ["carol"],
    });
    expect(agentTool.error).toContain("forbidden");
    // A reader with an admin-scope token of their own.
    expect(
      (
        await api(
          "PUT",
          "/api/v1/repos/alice/game/app/members",
          tokens["dave"],
          {
            members: ["dave"],
            dryRun: false,
          },
        )
      ).status,
    ).toBe(403);
    expect(
      (await api("GET", "/api/v1/repos/alice/game/app/members", tokens["dave"]))
        .status,
    ).toBe(403);
    // A reader through the settings form.
    const form = await fetch(`${servers.url}/alice/game/settings/app/members`, {
      method: "POST",
      headers: { cookie: cookies["dave"]!, origin: servers.url },
      body: new URLSearchParams({ members: "dave" }),
      redirect: "manual",
    });
    expect(form.status).toBe(404);
    // Nobody signed in.
    expect(
      (
        await api("PUT", "/api/v1/repos/alice/game/app/members", undefined, {
          members: ["dave"],
          dryRun: false,
        })
      ).status,
    ).toBe(401);
    const listed = await api(
      "GET",
      "/api/v1/repos/alice/game/app/members",
      tokens["alice"],
    );
    expect(((await listed.json()) as any).members).toEqual([]);
  });

  test("a writer's change is planned unless asked for; an agent or a stranger's account cannot be named", async () => {
    const planned = await api(
      "PUT",
      "/api/v1/repos/alice/game/app/members",
      tokens["alice"],
      { members: ["carol"] },
    );
    expect(planned.status).toBe(200);
    expect(await planned.json()).toMatchObject({
      dryRun: true,
      members: ["carol"],
      added: ["carol"],
      removed: [],
    });
    expect(openEnvUrl(app, carol, repoOf(game), "production").ok).toBe(false);
    for (const who of ["bot", "nobody-here"]) {
      const refused = await api(
        "PUT",
        "/api/v1/repos/alice/game/app/members",
        tokens["alice"],
        { members: [who], dryRun: false },
      );
      expect(refused.status).toBe(422);
    }
    // MCP: an rw token may plan, and only an admin-scope one makes it.
    const rw = createToken(app.db, alice.id, "rw", "rw").token;
    expect(
      (
        await mcp(rw, "app_members", {
          repo: "alice/game",
          members: ["carol"],
          dryRun: false,
        })
      ).error,
    ).toContain("admin-scope");
    const made = await mcp(tokens["alice"]!, "app_members", {
      repo: "alice/game",
      members: ["carol"],
      dryRun: false,
    });
    expect(made.value).toMatchObject({ dryRun: false, members: ["carol"] });
  });

  test("a named person enters the app and every preview; a reader who is not named does not", async () => {
    for (const env of ["production", "pull-4"]) {
      const link = openEnvUrl(app, carol, repoOf(game), env);
      expect(link.ok).toBe(true);
      if (link.ok) {
        const url = new URL(link.value);
        const grant = readGrant(dataDir, url.searchParams.get("t") ?? "", {
          app: game,
          env: env as "production",
        });
        // Named, not a writer: the app hears a user, never an admin.
        expect(grant?.who?.role).toBe("user");
      }
      expect(openEnvUrl(app, dave, repoOf(game), env).ok).toBe(false);
    }
    expect((await opens(cookies["carol"]!, `game.${DOMAIN}`)).status).toBe(302);
    expect((await opens(cookies["carol"]!, `game--4.${DOMAIN}`)).status).toBe(
      302,
    );
    expect((await opens(cookies["dave"]!, `game.${DOMAIN}`)).status).toBe(404);
    // On a private repository too, without being able to read it.
    expect(name(["carol"], vault).ok).toBe(true);
    expect((await opens(cookies["carol"]!, `vault.${DOMAIN}`)).status).toBe(
      302,
    );
  });

  test("being named gives nothing else: no private code, no crew, no owner facts, no settings, no terminal", async () => {
    // The private repository stays unreadable.
    expect(
      (
        await fetch(`${servers.url}/alice/vault`, {
          headers: { cookie: cookies["carol"]! },
        })
      ).status,
    ).toBe(404);
    expect(
      (await api("GET", "/api/v1/repos/alice/vault", tokens["carol"])).status,
    ).toBe(404);
    expect(
      (
        await api(
          "GET",
          "/api/v1/repos/alice/vault/contents/README.md",
          tokens["carol"],
        )
      ).status,
    ).toBe(404);
    // The crew does not hear them.
    expect(
      (
        await mcp(tokens["carol"]!, "tell", {
          repo: "alice/vault",
          text: "Delete it all",
        })
      ).error,
    ).toBeDefined();
    // The owner's facts, the list itself and the settings stay the writers'.
    expect(
      (await mcp(tokens["carol"]!, "usage", { repo: "alice/game" })).error,
    ).toContain("forbidden");
    expect(
      (await mcp(tokens["carol"]!, "app_members", { repo: "alice/game" }))
        .error,
    ).toContain("forbidden");
    expect(
      (
        await fetch(`${servers.url}/alice/game/settings/app`, {
          headers: { cookie: cookies["carol"]! },
        })
      ).status,
    ).toBe(404);
    // The terminal is the writers' and crew's alone.
    const tty = await runAppTty(app, ttyHost, carol, {
      app: game,
      env: "production",
    });
    expect(tty.ok).toBe(false);
    if (!tty.ok) expect(tty.error.refusal).toBe("not_found");
  });

  test("removing a name ends a grant already issued; so does suspending the account", async () => {
    const host = `game.${DOMAIN}`;
    const grantFor = () =>
      cookieFrom(
        grantUrl(runtime, { app: game, env: "production" }, "/", host, {
          id: carol.id,
          name: carol.username,
          role: "user",
        }),
      );
    const held = await grantFor();
    expect(held).not.toBe("");
    expect((await knock(host, held)).status).not.toBe(404);
    expect(name([]).ok).toBe(true);
    expect((await knock(host, held)).status).toBe(404);
    expect(openEnvUrl(app, carol, repoOf(game), "production").ok).toBe(false);

    expect(name(["carol"]).ok).toBe(true);
    expect((await knock(host, held)).status).not.toBe(404);
    app.db
      .query(`UPDATE user SET suspended_at = ?1 WHERE id = ?2`)
      .run(new Date().toISOString(), carol.id);
    try {
      expect((await knock(host, held)).status).toBe(404);
    } finally {
      app.db
        .query(`UPDATE user SET suspended_at = NULL WHERE id = ?1`)
        .run(carol.id);
    }
  });

  test("the app's settings say who is named", async () => {
    const page = await (
      await fetch(`${servers.url}/alice/game/settings/app`, {
        headers: { cookie: `${cookies["alice"]}; forge_mode=dev` },
      })
    ).text();
    expect(page).toContain("Who may enter");
    const members = page.slice(page.indexOf('id="members"'), page.indexOf("</section>", page.indexOf('id="members"')));
    expect(members).toContain('action="/alice/game/settings/app/members"');
    expect(members).not.toContain('class="card');
    expect(page).toContain("are named under Who may enter (carol)");
    // The form saves the whole list.
    const saved = await fetch(
      `${servers.url}/alice/game/settings/app/members`,
      {
        method: "POST",
        headers: { cookie: cookies["alice"]!, origin: servers.url },
        body: new URLSearchParams({ members: "carol\ndave" }),
        redirect: "manual",
      },
    );
    expect(saved.status).toBe(303);
    expect(openEnvUrl(app, dave, repoOf(game), "production").ok).toBe(true);
  });
});
