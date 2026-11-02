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
import { AppsRuntime, envsFor } from "../src/apps/runtime.ts";
import { runAppTty, type TtyHost } from "../src/apps/tty.ts";
import type { AppRecord } from "../src/core/apps.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { audienceFilter } from "../src/core/event_audience.ts";
import { createRun, listRuns } from "../src/core/runs.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { pullWord, pullWords } from "../src/web/studio/words.ts";
import { servingHistory } from "../src/web/studio/words.ts";
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
      const made = await createUser(app.db, { origin: "seed", trusted: true,
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

  test("a reader sees none of a private app's state or errors; a writer sees it", async () => {
    // The runtime knows production from the first deploy on.
    expect(envsFor(app, alice, record).length).toBeGreaterThan(0);
    expect(envsFor(app, bot, record).length).toBeGreaterThan(0);
    expect(envsFor(app, carol, record)).toEqual([]);
    expect(envsFor(app, undefined, record)).toEqual([]);
    const as = (cookie: string) =>
      fetch(`${servers.url}/api/v1/repos/alice/ledger/app`, {
        headers: { cookie },
      }).then((r) => r.json() as Promise<any>);
    expect((await as(carolCookie)).environments).toEqual([]);
    expect((await as(aliceCookie)).environments.length).toBeGreaterThan(0);
  });

  test("a private app's runs and logs are refused to a reader and an anonymous visitor, who get no Runs tab (#906); a writer reads them", async () => {
    const run = listRuns(app.db, record.repoId, { kind: "deploy", limit: 1 })[0];
    expect(run).toBeDefined();
    if (run === undefined) return;
    const base = `${servers.url}/alice/ledger`;
    const api = `${servers.url}/api/v1/repos/alice/ledger`;
    const paths = [
      `${base}/runs/${run.id}`,
      `${base}/runs/${run.id}?all=1`,
      `${api}/runs/${run.id}`,
      `${api}/runs/${run.id}/log`,
    ];
    for (const cookie of [carolCookie, ""]) {
      const headers = cookie === "" ? {} : { cookie };
      for (const path of paths) {
        const res = await fetch(path, { headers, redirect: "manual" });
        expect(`${path} ${res.status}`).toBe(`${path} 404`);
      }
      const listed = (await (
        await fetch(`${api}/runs`, { headers })
      ).json()) as any;
      expect(listed.items).toEqual([]);
      const page = await (
        await fetch(`${base}/runs`, { headers })
      ).text();
      expect(page).not.toContain(run.id);
      // No door that leads nowhere: no Runs tab, no Runs in the palette.
      const home = await (await fetch(base, { headers })).text();
      expect(home).not.toContain('/alice/ledger/runs"');
    }
    const writer = await (await fetch(base, { headers: { cookie: aliceCookie } })).text();
    expect(writer).toContain('href="/alice/ledger/runs"');
    for (const path of paths) {
      const res = await fetch(path, { headers: { cookie: aliceCookie } });
      expect(`${path} ${res.status}`).toBe(`${path} 200`);
    }
  });

  test("a private app's run and serving events reach only those who may enter it", () => {
    const event = (kind: string) => ({
      id: 1,
      kind,
      repoId: record.repoId,
      actorId: null,
      payload: { summary: "deploy failed: a secret path" },
      createdAt: new Date().toISOString(),
    });
    for (const kind of ["run.finished", "app.serving", "app.stopped"]) {
      expect(audienceFilter(app.db, carol)(event(kind) as any)).toBe(false);
      expect(audienceFilter(app.db, undefined)(event(kind) as any)).toBe(false);
      expect(audienceFilter(app.db, alice)(event(kind) as any)).toBe(true);
      expect(audienceFilter(app.db, bot)(event(kind) as any)).toBe(true);
    }
    // The repository's own events stay the readers'.
    expect(audienceFilter(app.db, carol)(event("issue.opened") as any)).toBe(true);
  });

  test("a merged pull's word tells a reader only that it merged", async () => {
    const commit = "a".repeat(40);
    const fakeRuntime = {
      status: () => [
        { env: "production", state: "running", commitOid: commit, error: "SECRET-ERROR" },
      ],
    } as never;
    const merged = {
      mergedAt: new Date().toISOString(),
      mergedOid: commit,
      headOid: commit,
      state: "closed",
    } as never;
    const ctxFor = (viewer: User | undefined) => ({
      db: app.db,
      dir: "",
      runtime: fakeRuntime,
      record,
      history: servingHistory(),
      viewer,
    });
    expect(await pullWord(ctxFor(carol), merged)).toEqual({ word: "shipped", note: "merged" });
    expect(await pullWord(ctxFor(undefined), merged)).toEqual({ word: "shipped", note: "merged" });
    expect((await pullWord(ctxFor(alice), merged)).note).toBe("production is serving it");
  });

  test("a page of merged pulls is worded as pullWord words them: the gate held once per page", async () => {
    const commit = "a".repeat(40);
    const other = "b".repeat(40);
    const pull = (id: string, oid: string) =>
      ({ id, mergedAt: new Date().toISOString(), mergedOid: oid, headOid: oid, state: "closed" }) as never;
    const pulls = [pull("m1", commit), pull("m2", other)];
    const runtimeAt = (state: string, serving: string) =>
      ({ status: () => [{ env: "production", state, commitOid: serving, error: "SECRET-ERROR" }] }) as never;
    const ctxFor = (viewer: User | undefined, runtime: never) => ({
      db: app.db,
      dir: "",
      runtime,
      record,
      history: servingHistory(),
      viewer,
    });
    // Production serves `commit` and has failed to bring `other` up.
    const caught = runtimeAt("running", commit);
    const failed = runtimeAt("failed", other);
    for (const runtime of [caught, failed]) {
      for (const viewer of [alice, bot, carol, undefined]) {
        const batched = await pullWords(ctxFor(viewer, runtime), pulls);
        const single = [
          await pullWord(ctxFor(viewer, runtime), pulls[0]!),
          await pullWord(ctxFor(viewer, runtime), pulls[1]!),
        ];
        expect(batched).toEqual(single);
        if (viewer === carol || viewer === undefined)
          for (const w of batched) {
            expect(w).toEqual({ word: "shipped", note: "merged" });
            expect(JSON.stringify(w)).not.toContain("SECRET-ERROR");
          }
      }
    }
    // The owner reads production: caught up for one, not for the other.
    const owner = await pullWords(ctxFor(alice, caught), pulls);
    expect(owner[0]!.note).toBe("production is serving it");
    expect(owner[1]!.note).not.toBe("merged");
    expect(owner[1]!.note).not.toBe("production is serving it");
  });

  test("the MCP's now and the tell page show a private app's runs only to those who may enter it", async () => {
    const issue = openIssue(app, alice, repo(), { title: "Count the books" });
    if (!issue.ok) throw new Error(String(issue.error));
    const run = createRun(app.db, {
      repoId: record.repoId,
      kind: "agent",
      issueId: issue.value.id,
      actorId: bot.id,
      reason: "assigned",
      summary: "SECRET-SUMMARY of the books",
    });
    const now = async (who: User) => {
      const token = createToken(app.db, who.id, "t", "ro").token;
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "now", arguments: {} },
        }),
      });
      return ((await res.json()) as any).result.content[0].text as string;
    };
    expect(await now(carol)).not.toContain(run.id);
    expect(await now(alice)).toContain(run.id);
    const tell = async (cookie: string) =>
      (
        await fetch(`${servers.url}/alice/ledger/issues/${issue.value.number}`, {
          headers: cookie === "" ? {} : { cookie },
        })
      ).text();
    for (const cookie of [carolCookie, ""]) {
      const page = await tell(cookie);
      expect(page).not.toContain("SECRET-SUMMARY");
      expect(page).not.toContain(run.id);
    }
    expect(await tell(aliceCookie)).toContain(run.id);
  });

  test("the owner page's shelf and search show a reader the private app's name, never its state or word", async () => {
    const rowOf = (page: string): string => {
      const at = page.indexOf('href="/alice/ledger"');
      expect(at).toBeGreaterThan(-1);
      return page.slice(at, page.indexOf("</a>", at));
    };
    const fetchAs = (path: string, cookie: string) =>
      fetch(`${servers.url}${path}`, {
        headers: cookie === "" ? {} : { cookie },
      }).then((r) => r.text());
    for (const cookie of [carolCookie, ""]) {
      const shelf = rowOf(await fetchAs("/alice", cookie));
      expect(shelf).toContain("private app");
      expect(shelf).not.toContain("data-word");
      expect(shelf).not.toMatch(/serving|not running|not up|starting|asleep|live/);
      expect(shelf).not.toContain('data-tone="success"');
      const hit = rowOf(await fetchAs("/search?q=ledger", cookie));
      expect(hit).not.toMatch(/serving|not running|not up|starting|asleep|\blive\b/);
      expect(hit).not.toContain('data-tone="success"');
    }
    const owners = rowOf(await fetchAs("/alice", aliceCookie));
    expect(owners).not.toContain("private app");
    expect(owners).toContain("data-word");
    expect(owners).toMatch(/serving|not running|not up|starting|asleep|live/);
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
