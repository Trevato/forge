/**
 * Apps, end to end (docs/APPS.md): a new app runs in production seconds
 * after it exists; a pull gets a preview with a copy of production's data;
 * a push moves the preview; closing the pull removes it; a private app
 * answers only through a grant.
 *
 * The rest of the first suite is split by what it needs, each on a forge of
 * its own (#1798): `apps-slow-test`, `apps-identity`, `apps-crew`,
 * `apps-require-checks-green`, `apps-require-checks-red`; the New app form is
 * `apps-new`. The forge they share is `helpers/apps-forge.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { seconds, Stopwatch } from "../src/apps/timing.ts";
import { envDataDir, envDir, previewEnv } from "../src/apps/data.ts";
import { childEnv, freePort, PORT_RETRIES, runStep, startProcess } from "../src/apps/process.ts";
import type { AppManifest } from "../src/apps/manifest.ts";
import {
  enableApp,
  newApp,
  openEnvUrl,
  updateAppSettings,
} from "../src/actions/apps.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import type { AppRecord } from "../src/core/apps.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { type Repo } from "../src/core/repos.ts";
import { repoDir } from "../src/git/repos.ts";
import {
  getRun,
  listRuns,
  STOPPED_SUMMARY,
  type Run,
} from "../src/core/runs.ts";
import { runWord, servingHistory } from "../src/web/studio/words.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { readRunLog } from "../src/runs/log.ts";
import { grantedCookie } from "./helpers/identity.ts";
import {
  APPS_DOMAIN,
  deploySettled,
  fetchAsHost,
  startAppsForge,
  stopAppsForge,
  type AppsForge,
} from "./helpers/apps-forge.ts";

describe("apps: production, previews, data, gates", () => {
  let forge: AppsForge;
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let repo: Repo;
  let record: AppRecord;
  const DOMAIN = APPS_DOMAIN;

  const viaHost = (host: string, path = "/", init: RequestInit = {}) =>
    fetchAsHost(servers, host, path, init);

  /** Wait for the newest run matching `where` to finish, and return it. */
  const settled = (where: (run: Run) => boolean, timeoutMs?: number) =>
    deploySettled(app, repo.id, where, timeoutMs);

  const latest = (env: string) => (run: Run) => run.env === env;

  beforeAll(async () => {
    forge = await startAppsForge();
    ({ dataDir, app, servers, runtime, alice } = forge);
  }, 60_000);

  afterAll(async () => {
    await runtime.stop();
    await stopAppsForge(forge);
  });

  test("new app: a repository with a working app, running in production", async () => {
    const made = await newApp(app, alice, {
      name: "hello",
      description: "A place for notes",
      visibility: "public",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    repo = made.value.repo;
    record = made.value.app;
    expect(record.slug).toBe("hello");
    expect(record.access).toBe("public");

    const run = await settled(latest("production"));
    expect(run.state).toBe("ok");
    expect(run.summary).toContain(`http://hello.${DOMAIN}:${servers.port}`);
    expect(runtime.urlFor(record, "production")).toBe(
      `http://hello.${DOMAIN}:${servers.port}`,
    );

    const page = await viaHost(`hello.${DOMAIN}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("<h1>hello</h1>");
    expect(html).toContain("production");
    expect(html).toContain(run.commitOid.slice(0, 7));
    // A stranger is offered the app's sign-in; a signed identity is greeted.
    expect(html).toContain('href="/signin"');
    const greeted = await (
      await viaHost(`hello.${DOMAIN}`, "/", {
        headers: {
          cookie: await grantedCookie(app, servers.url, alice, record),
        },
      })
    ).text();
    expect(greeted).toContain("<b>alice</b>");
    expect(greeted).toContain('action="/signout"');
  }, 90_000);

  test("the proxy carries a form post; production data persists", async () => {
    const form = new FormData();
    form.set("body", "first note in production");
    // Anonymous, the app takes nothing; as alice, it keeps the note.
    const refused = await viaHost(`hello.${DOMAIN}`, "/notes", {
      method: "POST",
      body: form,
    });
    expect(refused.status).toBe(303);
    expect(await (await viaHost(`hello.${DOMAIN}`)).text()).not.toContain(
      "first note in production",
    );
    const posted = await viaHost(`hello.${DOMAIN}`, "/notes", {
      method: "POST",
      body: form,
      headers: { cookie: await grantedCookie(app, servers.url, alice, record) },
    });
    expect(posted.status).toBe(303);
    const html = await (await viaHost(`hello.${DOMAIN}`)).text();
    expect(html).toContain("first note in production");
    expect(html).toContain("alice ·");
    // The same data at the other doors: JSON, and MCP tools.
    const listed = (await (
      await viaHost(`hello.${DOMAIN}`, "/api/notes")
    ).json()) as { body: string; author_name: string }[];
    expect(listed.map((n) => n.body)).toEqual(["first note in production"]);
    expect(listed[0]?.author_name).toBe("alice");
    const mcp = (await (
      await viaHost(`hello.${DOMAIN}`, "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    ).json()) as { result: { tools: { name: string }[] } };
    expect(mcp.result.tools.map((t) => t.name)).toEqual([
      "list_notes",
      "add_note",
      "delete_note",
    ]);
  });

  test("a hostname that is no app falls through to the forge", async () => {
    const forge = await viaHost(`localhost`, "/");
    expect(forge.status).toBe(200);
    // Shaped like an app, naming none: the forge's pages must not appear
    // under a stranger's hostname.
    const unknown = await viaHost(`nothing.${DOMAIN}`, "/");
    expect(unknown.status).toBe(404);
    // A multi-label host is not an app's; the forge answers as itself.
    expect((await viaHost(`a.hello.${DOMAIN}`, "/")).status).toBe(200);
  });

  let pull: Pull;

  test("a pull gets a preview with a copy of production's data", async () => {
    const committed = await commitToBranch(app, alice, repo, {
      branch: "greeting",
      base: repo.defaultBranch,
      message: "Say hello",
      files: [{ path: "GREETING.md", content: "hi\n" }],
    });
    expect(committed.ok).toBe(true);
    const opened = await openPull(app, alice, repo, {
      title: "Say hello",
      baseBranch: repo.defaultBranch,
      headBranch: "greeting",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    pull = opened.value;

    const run = await settled(latest(`pull-${pull.number}`));
    expect(run.state).toBe("ok");
    expect(run.issueId).toBe(pull.id);

    const preview = await viaHost(`hello--${pull.number}.${DOMAIN}`);
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain(`preview of pull #${pull.number}`);
    // The note written in production is there: data was copied.
    expect(html).toContain("first note in production");

    // A note written in the preview never reaches production.
    const form = new FormData();
    form.set("body", "only in the preview");
    await viaHost(`hello--${pull.number}.${DOMAIN}`, "/notes", {
      method: "POST",
      body: form,
      headers: {
        cookie: await grantedCookie(
          app,
          servers.url,
          alice,
          record,
          `pull-${pull.number}`,
        ),
      },
    });
    expect(
      await (await viaHost(`hello--${pull.number}.${DOMAIN}`)).text(),
    ).toContain("only in the preview");
    expect(await (await viaHost(`hello.${DOMAIN}`)).text()).not.toContain(
      "only in the preview",
    );
  }, 90_000);

  test("a push to the pull's branch moves the preview and keeps its data", async () => {
    const before = listRuns(app.db, repo.id, {
      env: `pull-${pull.number}`,
    }).length;
    const committed = await commitToBranch(app, alice, repo, {
      branch: "greeting",
      message: "More greeting",
      files: [{ path: "GREETING.md", content: "hi again\n" }],
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const run = await settled(
      (r) =>
        r.env === `pull-${pull.number}` &&
        r.commitOid === committed.value.commitOid,
    );
    expect(run.state).toBe("ok");
    expect(
      listRuns(app.db, repo.id, { env: `pull-${pull.number}` }).length,
    ).toBe(before + 1);
    const html = await (
      await viaHost(`hello--${pull.number}.${DOMAIN}`)
    ).text();
    expect(html).toContain(committed.value.commitOid.slice(0, 7));
    expect(html).toContain("only in the preview");
  }, 90_000);

  test("merging the pull removes the preview and redeploys production", async () => {
    const merged = await mergePull(
      app,
      alice,
      repo,
      getPull(app.db, repo.id, pull.number)!,
      "merge",
    );
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const run = await settled(
      (r) => r.env === "production" && r.commitOid === merged.value.mergeOid,
    );
    expect(run.state).toBe("ok");
    // The preview is gone: no process, no directory, an honest page.
    const deadline = Date.now() + 40_000;
    while (
      existsSync(envDir(dataDir, record.id, `pull-${pull.number}`)) &&
      Date.now() < deadline
    )
      await Bun.sleep(50);
    expect(existsSync(envDir(dataDir, record.id, `pull-${pull.number}`))).toBe(
      false,
    );
    const gone = await viaHost(`hello--${pull.number}.${DOMAIN}`);
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain("is gone");
    // Production kept its data across the redeploy.
    expect(await (await viaHost(`hello.${DOMAIN}`)).text()).toContain(
      "first note in production",
    );
  }, 90_000);

  test("a private app answers only through a grant", async () => {
    const updated = updateAppSettings(app, alice, repo, { access: "private" });
    expect(updated.ok).toBe(true);
    expect((await viaHost(`hello.${DOMAIN}`)).status).toBe(404);

    // Anonymous visitors get nothing to open.
    expect(openEnvUrl(app, undefined, repo, "production").ok).toBe(false);
    const link = openEnvUrl(app, alice, repo, "production");
    expect(link.ok).toBe(true);
    if (!link.ok) return;
    const url = new URL(link.value);
    expect(url.host).toBe(`hello.${DOMAIN}:${servers.port}`);
    expect(url.pathname).toBe("/__forge/grant");
    const granted = await viaHost(url.host, `${url.pathname}${url.search}`);
    expect(granted.status).toBe(303);
    const cookie = granted.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("forge_grant_");
    const page = await viaHost(`hello.${DOMAIN}`, "/", {
      headers: { cookie: cookie.split(";")[0]! },
    });
    expect(page.status).toBe(200);
    // A grant for one environment is no grant for another.
    expect(
      (
        await viaHost(`hello--9.${DOMAIN}`, "/", {
          headers: { cookie: cookie.split(";")[0]! },
        })
      ).status,
    ).toBe(404);
    // A forged token is refused.
    const forged = await viaHost(
      url.host,
      `/__forge/grant?t=${record.id}.production.9999999999999.AAAA`,
    );
    expect(forged.status).toBe(404);

    // A person arriving by the link is sent to the forge to sign in and be
    // vouched for; a script gets the flat answer.
    const arrived = await viaHost(`hello.${DOMAIN}`, "/notes?x=1", {
      headers: { accept: "text/html,*/*" },
    });
    expect(arrived.status).toBe(303);
    const sentTo = new URL(arrived.headers.get("location") ?? "");
    expect(sentTo.pathname).toBe("/apps/open");
    expect(sentTo.searchParams.get("host")).toBe(`hello.${DOMAIN}`);
    expect(sentTo.searchParams.get("to")).toBe("/notes?x=1");
    expect(
      (await viaHost(`hello.${DOMAIN}`, "/", { headers: { accept: "*/*" } }))
        .status,
    ).toBe(404);
    // At the forge: a stranger is asked to sign in; a reader is sent back
    // with a grant for the page they wanted; someone who cannot see the
    // repository gets not found.
    const open = `${servers.url}${sentTo.pathname}${sentTo.search}`;
    const anonymous = await fetch(open, { redirect: "manual" });
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location") ?? "").toContain("/signin");
    const token = createToken(app.db, alice.id, "open", "rw");
    const vouched = await fetch(open, {
      redirect: "manual",
      headers: { authorization: `Bearer ${token.token}` },
    });
    expect(vouched.status).toBe(302);
    const back = new URL(vouched.headers.get("location") ?? "");
    expect(back.host).toBe(`hello.${DOMAIN}:${servers.port}`);
    expect(back.pathname).toBe("/__forge/grant");
    expect(back.searchParams.get("to")).toBe("/notes?x=1");
    updateAppSettings(app, alice, repo, { access: "public" });
  });

  test("archiving stops the app, keeps its data, and its URL says it is archived", async () => {
    expect(runtime.envStatus(record, "production")?.state).toBe("running");
    const data = envDataDir(dataDir, record.id, "production");
    writeFileSync(join(data, "archive-marker"), "kept");

    const archived = await updateRepoSettings(app, alice, repo, {
      archived: true,
    });
    expect(archived.ok).toBe(true);

    expect(runtime.envStatus(record, "production")?.state).not.toBe("running");
    expect(existsSync(join(data, "archive-marker"))).toBe(true);
    const page = await viaHost(`hello.${DOMAIN}`);
    expect(page.status).toBe(503);
    expect(await page.text()).toContain("hello is archived");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    expect(page.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    // A visit does not wake it.
    expect((await viaHost(`hello.${DOMAIN}`)).status).toBe(503);
    expect(runtime.envStatus(record, "production")?.state).not.toBe("running");

    // Waking restarts production on the same data directory.
    const woke = await updateRepoSettings(app, alice, repo, {
      archived: false,
    });
    expect(woke.ok).toBe(true);
    for (
      let i = 0;
      i < 600 && runtime.envStatus(record, "production")?.state !== "running";
      i++
    )
      await Bun.sleep(100);
    expect(runtime.envStatus(record, "production")?.state).toBe("running");
    expect(readFileSync(join(data, "archive-marker"), "utf8")).toBe("kept");
    expect((await viaHost(`hello.${DOMAIN}`)).status).toBe(200);
  }, 120_000);
});

describe("a preview whose copied data the build cannot read starts fresh (issue #36)", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  const DOMAIN = "retry.test";

  async function settled(
    where: (run: Run) => boolean,
    repoId: string,
    timeoutMs = 30_000,
  ): Promise<Run> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = listRuns(app.db, repoId, { kind: "deploy", limit: 50 }).find(
        where,
      );
      if (
        run &&
        (run.state === "ok" ||
          run.state === "failed" ||
          run.state === "cancelled")
      )
        return run;
      await Bun.sleep(50);
    }
    throw new Error("run did not settle in time");
  }

  // Never checks in, so `install` has nothing to do: the deploy starts the
  // process directly, no `bun install` on the critical path.
  const FORGE_JSON = JSON.stringify({
    app: { run: "sh run.sh", install: "", health: "/", ready: 5 },
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-retry-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 2,
    });
    await runtime.start();
    const created = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;
  }, 30_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a build too old for a migration on main comes up on the retry", async () => {
    const made = await createRepo(app, alice, {
      name: "schema-ahead",
      visibility: "public",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const repo = made.value;
    const committed = await commitToBranch(app, alice, repo, {
      message: "Refuse data from a schema this build does not know",
      files: [
        { path: "forge.json", content: FORGE_JSON },
        {
          path: "run.sh",
          content: `if [ -f "$FORGE_APP_DATA/schema-22" ]; then
  echo "database is at schema 22, this build only knows 21 - refusing to run" 1>&2
  exit 1
fi
exec bun -e "Bun.serve({port:Number(process.env.PORT),hostname:'127.0.0.1',fetch:()=>new Response('ok')})"
`,
        },
      ],
    });
    expect(committed.ok).toBe(true);
    const enabled = enableApp(app, alice, repo, {});
    expect(enabled.ok).toBe(true);
    if (!enabled.ok) return;
    const record = enabled.value;

    const production = await settled((r) => r.env === "production", repo.id);
    expect(production.state).toBe("ok");

    // A migration lands on `main` — simulated here the way the issue
    // describes it, a schema file production now has that an older build
    // does not know how to read.
    writeFileSync(
      join(envDataDir(dataDir, record.id, "production"), "schema-22"),
      "22",
    );

    const branch = await commitToBranch(app, alice, repo, {
      branch: "note",
      base: repo.defaultBranch,
      message: "A trivial, unrelated change",
      files: [{ path: "NOTE.md", content: "hi\n" }],
    });
    expect(branch.ok).toBe(true);
    const opened = await openPull(app, alice, repo, {
      title: "Unrelated change",
      baseBranch: repo.defaultBranch,
      headBranch: "note",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const run = await settled(
      (r) => r.env === `pull-${opened.value.number}`,
      repo.id,
    );
    expect(run.state).toBe("ok");

    const { lines } = readRunLog(dataDir, run.id);
    const text = lines.join("\n");
    expect(text).toMatch(/data: (copied|cloned) from production/);
    expect(text).toContain("exited with code 1 before answering");
    expect(text).toContain(
      "the copied data was not usable by this build; the preview is starting on empty data",
    );
    expect(text).toContain(`serving http://`);

    // The retry's data directory does not carry the discarded copy's file.
    const previewData = envDataDir(
      dataDir,
      record.id,
      previewEnv(opened.value.number),
    );
    expect(existsSync(join(previewData, "schema-22"))).toBe(false);

    const page = await fetch(`${servers.url}/`, {
      headers: { host: `schema-ahead--${opened.value.number}.${DOMAIN}` },
    });
    expect(page.status).toBe(200);
  }, 60_000);

  test("an app that always exits retries exactly once in a preview, and never in production", async () => {
    const made = await createRepo(app, alice, {
      name: "always-fails",
      visibility: "public",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const repo = made.value;
    const committed = await commitToBranch(app, alice, repo, {
      message: "A run that never comes up",
      files: [
        { path: "forge.json", content: FORGE_JSON },
        {
          path: "run.sh",
          content: `echo "boom" 1>&2\nexit 1\n`,
        },
      ],
    });
    expect(committed.ok).toBe(true);
    const enabled = enableApp(app, alice, repo, {});
    expect(enabled.ok).toBe(true);
    if (!enabled.ok) return;

    // Production: seeded empty, never a copy, so it gets exactly one try.
    const production = await settled((r) => r.env === "production", repo.id);
    expect(production.state).toBe("failed");
    const prodLog = readRunLog(dataDir, production.id).lines;
    expect(prodLog.filter((l) => l.startsWith("$ sh run.sh")).length).toBe(1);
    expect(prodLog.some((l) => l.includes("starting on empty data"))).toBe(
      false,
    );

    const branch = await commitToBranch(app, alice, repo, {
      branch: "note",
      base: repo.defaultBranch,
      message: "A trivial change",
      files: [{ path: "NOTE.md", content: "hi\n" }],
    });
    expect(branch.ok).toBe(true);
    const opened = await openPull(app, alice, repo, {
      title: "Trivial",
      baseBranch: repo.defaultBranch,
      headBranch: "note",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const run = await settled(
      (r) => r.env === `pull-${opened.value.number}`,
      repo.id,
    );
    expect(run.state).toBe("failed");
    const previewLog = readRunLog(dataDir, run.id).lines;
    // Exactly one retry: the process is started twice, never more.
    expect(previewLog.filter((l) => l.startsWith("$ sh run.sh")).length).toBe(
      2,
    );
    expect(
      previewLog.some((l) =>
        l.includes(
          "the copied data was not usable by this build; the preview is starting on empty data",
        ),
      ),
    ).toBe(true);
    // The run's summary names the first failure's reason too.
    expect(run.summary ?? "").toContain("retried on empty data");
    expect(run.summary ?? "").toContain("exited with code 1 before answering");
  }, 60_000);
});

describe("a start failure is said in the app's own terms, not the forge's paths (issue #202)", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let cookie: string;
  const DOMAIN = "leaky.test";

  async function settled(
    where: (run: Run) => boolean,
    repoId: string,
    timeoutMs = 30_000,
  ): Promise<Run> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = listRuns(app.db, repoId, { kind: "deploy", limit: 50 }).find(
        where,
      );
      if (
        run &&
        (run.state === "ok" ||
          run.state === "failed" ||
          run.state === "cancelled")
      )
        return run;
      await Bun.sleep(50);
    }
    throw new Error("run did not settle in time");
  }

  const FORGE_JSON = JSON.stringify({
    app: { run: "bun run src/server.ts", install: "", health: "/", ready: 3 },
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-leaky-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 2,
    });
    await runtime.start();
    const created = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;
    cookie = (
      (
        await fetch(`${servers.url}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "alice",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  }, 30_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a deploy whose app throws on import names its own file, never the forge's data directory or the app's id", async () => {
    const made = await createRepo(app, alice, {
      name: "throws",
      visibility: "public",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const repo = made.value;
    const committed = await commitToBranch(app, alice, repo, {
      message: "An app that throws on import",
      files: [
        { path: "forge.json", content: FORGE_JSON },
        { path: "src/server.ts", content: `throw new Error("boom");\n` },
      ],
    });
    expect(committed.ok).toBe(true);
    const enabled = enableApp(app, alice, repo, {});
    expect(enabled.ok).toBe(true);
    if (!enabled.ok) return;
    const record = enabled.value;

    const run = await settled((r) => r.env === "production", repo.id);
    expect(run.state).toBe("failed");

    const notForgePaths = (text: string): void => {
      expect(text).not.toContain(dataDir);
      expect(text).not.toContain(record.id);
    };

    // The error the runtime stores — the same one a run's summary and the
    // studio's head card both draw from — is the thrown message (issue
    // #270), not a stack frame; it never leaks the forge's own paths either.
    const status = runtime.envStatus(record, "production");
    expect(status?.error ?? "").toContain("boom");
    notForgePaths(status?.error ?? "");
    expect(run.summary ?? "").toContain("boom");
    notForgePaths(run.summary ?? "");

    // The full log still has the frame, path-stripped down to the app's
    // own file rather than the forge's data directory or the app's id.
    const { lines } = readRunLog(dataDir, run.id);
    const log = lines.join("\n");
    expect(log).toContain("src/server.ts");
    notForgePaths(log);

    // The studio's app page renders the same error in its head, for a
    // reader who never asked to see the forge's own filesystem.
    const page = await fetch(`${servers.url}/${repo.ownerName}/${repo.name}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
    });
    expect(page.status).toBe(200);
    notForgePaths(await page.text());
  }, 60_000);
});


/**
 * Issue #254: the terminal command has a `login@host` in it, which an
 * email-scanning edge on the forge's own domain rewrites into a `mailto:`
 * link — the one line a reader must copy character for character, turned
 * into something that neither shows the login nor copies as text.
 * `terminalLine` (`src/web/ui.ts`) now wraps it in the `<!--email_off-->`
 * marker such scanners honour, which leaves the command itself — the thing
 * a paste must carry — untouched.
 */
describe("the App page's terminal line survives an email-scanning edge (issue #254)", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let base: string;
  let cookie: string;
  const DOMAIN = "apps.test";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-terminal-edge-"));
    app = createApp({ dataDir, port: 0 });
    app.config.sshPort = 2222;
    app.config.sshHostKey =
      "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    servers = await serve(app);
    base = servers.url;
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    await runtime.start();
    const created = await createUser(app.db, { origin: "seed", trusted: true,
      username: "priya",
      email: "priya@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    const made = await newApp(app, created.value, {
      name: "beacon",
      description: "a light that stays on",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    cookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "priya",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  });

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the command sits between email_off markers, and the visible text is still the exact line", async () => {
    const res = await fetch(`${base}/priya/beacon/app`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    const command = `ssh -p 2222 beacon@localhost`;
    // The whole command is wrapped, as a single unbroken run of text — an
    // email-scanning edge honours the markers and leaves what is between
    // them alone, so a reader still copies exactly this string.
    expect(html).toContain(`<!--email_off-->${command}<!--/email_off-->`);
    // Strip only the markers: what is left is exactly the command inside
    // its tag, unchanged — nothing dropped or split, no stray space added.
    const withoutMarkers = html.replace(/<!--\/?email_off-->/g, "");
    expect(withoutMarkers).toContain(`<code class="mono break">${command}</code>`);
    expect(html).toContain("host key SHA256:abcdefghijklmnopqrstuvwxyz");
  });
});

describe("the forge's own restart never reads as this deploy's failure (issue #255)", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  const DOMAIN = "stop-mid-deploy.test";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-stop-mid-deploy-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 2,
    });
    await runtime.start();
    const created = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;
  }, 30_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an install still in flight when the runtime stops finishes cancelled, not failed", async () => {
    const made = await createRepo(app, alice, {
      name: "slow-install",
      visibility: "public",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const repo = made.value;
    // A single simple command as `sh -c`'s whole argument execs straight
    // into it (no forked shell left to orphan): a `SIGKILL` reaches this
    // `sleep` directly, so aborting it does not itself depend on the fix
    // under test.
    const committed = await commitToBranch(app, alice, repo, {
      message: "An install that blocks until stopped",
      files: [
        {
          path: "forge.json",
          content: JSON.stringify({
            app: {
              run: "bun -e \"Bun.serve({port:Number(process.env.PORT),hostname:'127.0.0.1',fetch:()=>new Response('ok')})\"",
              install: "sleep 30",
              health: "/",
              ready: 5,
            },
          }),
        },
      ],
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const enabled = enableApp(app, alice, repo, {});
    expect(enabled.ok).toBe(true);
    if (!enabled.ok) return;
    const record = enabled.value;

    // Wait for the install step to actually be running before pulling the
    // rug: a stop before it ever started would prove nothing about the
    // abort path this test means to cover.
    const deadline = Date.now() + 10_000;
    let runId: string | undefined;
    while (Date.now() < deadline) {
      const inFlight = listRuns(app.db, repo.id, { kind: "deploy" }).find(
        (r) => r.env === "production",
      );
      if (
        inFlight?.state === "running" &&
        readRunLog(dataDir, inFlight.id).lines.some((l) =>
          l.includes("$ sleep 30"),
        )
      ) {
        runId = inFlight.id;
        break;
      }
      await Bun.sleep(20);
    }
    expect(runId).toBeDefined();

    await runtime.stop();

    const finished = getRun(app.db, runId!);
    expect(finished?.state).toBe("cancelled");
    expect(finished?.summary).toBe(STOPPED_SUMMARY);

    const word = await runWord(
      {
        db: app.db,
        dir: repoDir(app.reposRoot, repo.ownerName, repo.name),
        runtime: undefined,
        record: undefined,
        history: servingHistory(),
        viewer: undefined,
      },
      finished!,
    );
    expect(word).toEqual({
      word: "cancelled",
      note: "interrupted by a restart",
    });

    // The studio's own word for it is the quiet one, never the word for a
    // broken deploy — and that is what the run's own page renders.
    const cookie = (
      (
        await fetch(`${servers.url}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "alice",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    const page = await fetch(
      `${servers.url}/${repo.ownerName}/${repo.name}/runs/${runId}`,
      { headers: { cookie: `${cookie}; forge_mode=studio` } },
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('data-word="cancelled"');
    expect(html).not.toContain('data-word="stopped"');

    // The environment itself does not advertise the restart as why it is
    // down: nothing ever served, and no error carries over from a run that
    // was never this commit's fault.
    const status = runtime.envStatus(record, "production");
    expect(status?.error).toBeUndefined();
  }, 30_000);
});

describe("a start that fails reports the message, not its last line (issue #270)", () => {
  const manifest: AppManifest = {
    run: "",
    install: null,
    test: null,
    health: "/",
    ready: 2,
    tty: null,
    service: null,
    looks: ["/"],
  };

  // A realistic crash: the message, a blank line, three frames, then the
  // runtime's version banner — the exact shape that used to leave only
  // the frame and the banner behind.
  const CRASH = `TypeError [ERR_INVALID_URL]: "http://notes.127.0.0.1:3999" cannot be parsed as a URL
      at src/env.ts:22:37
      at src/server.ts:3:1
      at node:internal/main:1:1

Bun v1.3.14 (Linux x64 baseline)`;

  test("start: the crash's message wins, the frames and banner do not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-crash-"));
    try {
      const started = await startProcess({
        dir,
        dataDir: dir,
        manifest: { ...manifest, run: `printf '%s' '${CRASH}' 1>&2; exit 1` },
        env: "production",
        url: "http://app.test",
        commitOid: "0".repeat(40),
        forgeUrl: "http://forge.test",
        identityKey: "key",
        log: () => {},
        signal: new AbortController().signal,
      });
      expect(started.ok).toBe(false);
      if (started.ok) return;
      expect(started.error.message).toContain(
        'TypeError [ERR_INVALID_URL]: "http://notes.127.0.0.1:3999" cannot be parsed as a URL',
      );
      expect(started.error.message).not.toContain("at src/env.ts");
      expect(started.error.message).not.toContain("Bun v1.3.14");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("install: the same crash, the same message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-crash-install-"));
    try {
      const result = await runStep(
        "install",
        `printf '%s' '${CRASH}' 1>&2; exit 1`,
        {
          cwd: dir,
          env: childEnv({}),
          log: () => {},
          signal: new AbortController().signal,
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain(
        'TypeError [ERR_INVALID_URL]: "http://notes.127.0.0.1:3999" cannot be parsed as a URL',
      );
      expect(result.error).not.toContain("at src/env.ts");
      expect(result.error).not.toContain("Bun v1.3.14");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("test: the same crash, the same message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-crash-test-"));
    try {
      const result = await runStep(
        "test",
        `printf '%s' '${CRASH}' 1>&2; exit 1`,
        {
          cwd: dir,
          env: childEnv({}),
          log: () => {},
          signal: new AbortController().signal,
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain(
        'TypeError [ERR_INVALID_URL]: "http://notes.127.0.0.1:3999" cannot be parsed as a URL',
      );
      expect(result.error).not.toContain("at src/env.ts");
      expect(result.error).not.toContain("Bun v1.3.14");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("a plain exit 1 with no output keeps the bare 'exited with code' message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-crash-plain-"));
    try {
      const result = await runStep("check", "exit 1", {
        cwd: dir,
        env: childEnv({}),
        log: () => {},
        signal: new AbortController().signal,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("check exited with code 1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

// ---- the boot (issue #296) ----
/**
 * A restart brings production back first, and says where each deploy's
 * time went (issue #296): every app's production is reconciled before any
 * preview, and the log names the wait for a turn, the manifest, the
 * checkout, the data and the process's own start, each with its seconds.
 */
describe("the stopwatch a deploy's log reads from", () => {
  test("each lap is the time since the one before, in order, on one line", () => {
    let now = 1_000;
    const clock = new Stopwatch(() => now);
    now += 0; // no wait for a turn
    clock.lap("turn");
    now += 340;
    clock.lap("checkout");
    now += 20_060;
    clock.lap("data");
    expect(clock.elapsed()).toBe(20_400);
    expect(clock.line("starting the process")).toBe(
      "timing: starting the process 20.4s after the deploy started — turn 0.0s · checkout 0.3s · data 20.1s",
    );
  });

  test("seconds never go negative, and round to a tenth", () => {
    expect(seconds(-5)).toBe("0.0s");
    expect(seconds(1_250)).toBe("1.3s");
  });
});

describe("a restart brings every app's production up before any preview", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  const DOMAIN = "boot.test";
  const repos: Repo[] = [];
  const previews: string[] = [];

  // No package.json, so a checkout is never warm and a preview is never
  // put back to sleep at boot: every environment deploys again.
  const FORGE_JSON = JSON.stringify({
    app: { run: "sh run.sh", install: "", health: "/", ready: 10 },
  });
  const RUN_SH = `exec bun -e "Bun.serve({port:Number(process.env.PORT),hostname:'127.0.0.1',fetch:()=>new Response('ok')})"\n`;

  const runtimeFor = (): AppsRuntime =>
    new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      // One permit: the order the gate hands them out is the order the
      // environments come up, and that order is the assertion.
      concurrency: 1,
    });

  async function settledAll(
    where: (run: Run) => boolean,
    count: number,
  ): Promise<Run[]> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const runs = repos
        .flatMap((r) => listRuns(app.db, r.id, { kind: "deploy", limit: 50 }))
        .filter(where);
      if (
        runs.length >= count &&
        runs.every((r) => r.state === "ok" || r.state === "failed")
      )
        return runs;
      await Bun.sleep(50);
    }
    throw new Error("runs did not settle in time");
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-boot-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = runtimeFor();
    await runtime.start();
    const created = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;
    for (const name of ["first", "second"]) {
      const made = await createRepo(app, alice, {
        name,
        visibility: "public",
      });
      if (!made.ok) throw new Error(String(made.error));
      const repo = made.value;
      repos.push(repo);
      const committed = await commitToBranch(app, alice, repo, {
        message: "An app",
        files: [
          { path: "forge.json", content: FORGE_JSON },
          { path: "run.sh", content: RUN_SH },
        ],
      });
      if (!committed.ok) throw new Error(JSON.stringify(committed.error));
      const enabled = enableApp(app, alice, repo, {});
      if (!enabled.ok) throw new Error(String(enabled.error));
      const branch = await commitToBranch(app, alice, repo, {
        branch: "note",
        base: repo.defaultBranch,
        message: "A note",
        files: [{ path: "NOTE.md", content: "hi\n" }],
      });
      if (!branch.ok) throw new Error(JSON.stringify(branch.error));
      const opened = await openPull(app, alice, repo, {
        title: "A note",
        baseBranch: repo.defaultBranch,
        headBranch: "note",
      });
      if (!opened.ok) throw new Error(String(opened.error));
      previews.push(`pull-${opened.value.number}`);
    }
    await settledAll(() => true, 4);
  }, 90_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("both productions answer before either preview, and the log says where the time went", async () => {
    await runtime.stop();
    runtime = runtimeFor();
    await runtime.start();
    const boot = await settledAll((r) => r.reason === "boot", 4);
    expect(boot.every((r) => r.state === "ok")).toBe(true);
    const order = [...boot]
      .sort((a, b) => Date.parse(a.servingAt!) - Date.parse(b.servingAt!))
      .map((r) => (r.env === "production" ? "production" : "preview"));
    expect(order).toEqual(["production", "production", "preview", "preview"]);

    const production = boot.find((r) => r.env === "production")!;
    const text = readRunLog(dataDir, production.id).lines.join("\n");
    expect(text).toMatch(
      /timing: starting the process \d+\.\ds after the deploy started — turn \d+\.\ds · manifest \d+\.\ds · checkout \d+\.\ds · data \d+\.\ds · setup \d+\.\ds/,
    );
    expect(text).toMatch(
      /timing: answered \d+\.\ds after the process was started/,
    );
  }, 90_000);
});

describe("start: a port lost to another process", () => {
  const manifest: AppManifest = {
    run: `bun -e 'Bun.serve({ port: Number(process.env.PORT), hostname: "127.0.0.1", fetch: () => new Response("ok") })'`,
    install: null,
    test: null,
    health: "/",
    ready: 5,
    tty: null,
    service: null,
    looks: ["/"],
  };
  // Another process holding a port: it accepts and hangs up, so the health
  // check never mistakes it for the app.
  const hold = () =>
    Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { open: (socket) => void socket.end(), data() {} },
    });
  const start = async (
    dir: string,
    ports: (() => number) | undefined,
    over: Partial<AppManifest> = {},
  ) => {
    const lines: string[] = [];
    const started = await startProcess({
      dir,
      dataDir: dir,
      manifest: { ...manifest, ...over },
      env: "production",
      url: "http://app.test",
      commitOid: "0".repeat(40),
      forgeUrl: "http://forge.test",
      identityKey: "key",
      log: (line) => void lines.push(line),
      signal: new AbortController().signal,
      pickPort: ports,
    });
    return { started, lines };
  };

  test("an app that finds its port taken is started again on a fresh one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-port-race-"));
    const held = hold();
    const picks: number[] = [];
    try {
      const { started, lines } = await start(dir, () => {
        const port = picks.length === 0 ? held.port : freePort();
        picks.push(port);
        return port;
      });
      expect(picks.length).toBe(2);
      expect(picks[0]).toBe(held.port);
      expect(lines.join("\n")).toContain("the port was taken before the app bound it");
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      expect(started.value.handle.port).toBe(picks[1]!);
      expect(started.value.handle.port).not.toBe(held.port);
      const answer = await fetch(`http://127.0.0.1:${started.value.handle.port}/`);
      expect(await answer.text()).toBe("ok");
      await started.value.handle.stop();
    } finally {
      held.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("retries stop after PORT_RETRIES when every port is held", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-port-race-"));
    const holders = Array.from({ length: PORT_RETRIES + 1 }, hold);
    const picks: number[] = [];
    try {
      const { started, lines } = await start(
        dir,
        () => {
          const port = holders[picks.length]!.port;
          picks.push(port);
          return port;
        },
        { ready: 2 },
      );
      expect(started.ok).toBe(false);
      expect(picks.length).toBe(PORT_RETRIES + 1);
      expect(picks.length).toBe(3);
      expect(lines.filter((l) => l.includes("the port was taken")).length).toBe(PORT_RETRIES);
    } finally {
      for (const h of holders) h.stop(true);
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("an app that exits for another reason is not started again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-port-race-"));
    let picks = 0;
    try {
      const { started } = await start(
        dir,
        () => {
          picks++;
          return freePort();
        },
        { run: "echo boom 1>&2; exit 1" },
      );
      expect(started.ok).toBe(false);
      expect(picks).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
