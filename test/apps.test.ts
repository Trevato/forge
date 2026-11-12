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

import { getRepo } from "../src/core/repos.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../src/app.ts";
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
import { listApps, type AppRecord } from "../src/core/apps.ts";
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
import type { User } from "../src/core/users.ts";
import type { Servers } from "../src/http/server.ts";
import { readRunLog } from "../src/runs/log.ts";
import { grantedCookie } from "./helpers/identity.ts";
import {
  APPS_DOMAIN,
  appsRuntime,
  deploySettled,
  fetchAsHost,
  signedInCookie,
  startAppsForge,
  stopAppsForge,
  type AppsForge,
} from "./helpers/apps-forge.ts";
import { giveHistory } from "./helpers/history.ts";

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
    // Invariant: a new app is deployed to production and served at its own host, greeting a signed identity.
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
    // Invariant: an opened pull deploys a preview seeded from production's data, and the preview's writes stay in it.
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
    // Invariant: a push to the head branch redeploys the preview at the new commit on the data it already had.
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
    // Invariant: a merge redeploys production at the merge commit, and tears the preview down to a 404.
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
      await Bun.sleep(10);
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
    // Invariant: archiving stops production without losing its data, answers 503 on the security floor, and unarchiving wakes it.
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
      i < 6_000 && runtime.envStatus(record, "production")?.state !== "running";
      i++
    )
      await Bun.sleep(10);
    expect(runtime.envStatus(record, "production")?.state).toBe("running");
    expect(readFileSync(join(data, "archive-marker"), "utf8")).toBe("kept");
    expect((await viaHost(`hello.${DOMAIN}`)).status).toBe(200);
  }, 120_000);
});

// ---- shared by the stories below ----

/** A repository with an app, enabled, and its first production deploy settled. */
interface Deployed {
  readonly repo: Repo;
  readonly record: AppRecord;
  readonly production: Run;
}

async function deployApp(
  forge: AppsForge,
  name: string,
  files: { path: string; content: string }[],
): Promise<Deployed> {
  const made = await createRepo(forge.app, forge.alice, {
    name,
    visibility: "public",
  });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  const committed = await commitToBranch(forge.app, forge.alice, repo, {
    message: `The ${name} app`,
    files,
  });
  if (!committed.ok) throw new Error(JSON.stringify(committed.error));
  const enabled = enableApp(forge.app, forge.alice, repo, {});
  if (!enabled.ok) throw new Error(String(enabled.error));
  const production = await deploySettled(
    forge.app,
    repo.id,
    (r) => r.env === "production",
  );
  return { repo, record: enabled.value, production };
}

/** A trivial change on the branch `note`, opened as a pull: a preview to deploy. */
async function openNote(forge: AppsForge, repo: Repo): Promise<Pull> {
  const branch = await commitToBranch(forge.app, forge.alice, repo, {
    branch: "note",
    base: repo.defaultBranch,
    message: "A trivial, unrelated change",
    files: [{ path: "NOTE.md", content: "hi\n" }],
  });
  if (!branch.ok) throw new Error(JSON.stringify(branch.error));
  const opened = await openPull(forge.app, forge.alice, repo, {
    title: "A note",
    baseBranch: repo.defaultBranch,
    headBranch: "note",
  });
  if (!opened.ok) throw new Error(String(opened.error));
  return opened.value;
}

// ---- a restart brings every app's production up before any preview (issue #296) ----
// A restart brings production back first, and says where each deploy's
// time went: every app's production is reconciled before any preview, and
// the log names the wait for a turn, the manifest, the checkout, the data
// and the process's own start, each with its seconds.
// No package.json, so a checkout is never warm and a preview is never
// put back to sleep at boot: every environment deploys again.
const BOOT_FORGE_JSON = JSON.stringify({
  app: { run: "sh run.sh", install: "", health: "/", ready: 10 },
});
const BOOT_RUN_SH = `exec bun -e "Bun.serve({port:Number(process.env.PORT),hostname:'127.0.0.1',fetch:()=>new Response('ok')})"\n`;
let boot: AppsForge;
/** The runtime serving `boot` now: the restart replaces it. */
let bootRuntime: AppsRuntime;
const bootRepos: Repo[] = [];
/** The deploys the restart made, settled. */
let restarted: Run[];

async function bootSettled(
  where: (run: Run) => boolean,
  count: number,
): Promise<Run[]> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const runs = bootRepos
      .flatMap((r) =>
        listRuns(boot.app.db, r.id, { kind: "deploy", limit: 50 }),
      )
      .filter(where);
    if (
      runs.length >= count &&
      runs.every((r) => r.state === "ok" || r.state === "failed")
    )
      return runs;
    await Bun.sleep(10);
  }
  throw new Error("runs did not settle in time");
}

/** Two apps, a preview on the one the boot visits first, all deployed; then the forge's runtime restarted on one permit. */
async function restartBoot(): Promise<void> {
  // Before the restart, each environment only needs deploying once:
  // four permits, side by side.
  boot = await startAppsForge({ domain: "boot.test", concurrency: 4 });
  bootRuntime = boot.runtime;
  for (const name of ["first", "second"]) {
    const made = await createRepo(boot.app, boot.alice, {
      name,
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    const repo = made.value;
    bootRepos.push(repo);
    const committed = await commitToBranch(boot.app, boot.alice, repo, {
      message: "An app",
      files: [
        { path: "forge.json", content: BOOT_FORGE_JSON },
        { path: "run.sh", content: BOOT_RUN_SH },
      ],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const enabled = enableApp(boot.app, boot.alice, repo, {});
    if (!enabled.ok) throw new Error(String(enabled.error));
  }
  // One preview is enough to tell the orders apart, so long as it
  // belongs to the app the boot visits first: app by app, that
  // preview would come up between the two productions.
  const visitedFirst = listApps(boot.app.db)[0]!;
  await openNote(
    boot,
    bootRepos.find((r) => r.id === visitedFirst.repoId)!,
  );
  await bootSettled(() => true, 3);
  // The restart: one permit, so the order the gate hands them out is
  // the order the environments come up, and that order is asserted.
  await bootRuntime.stop();
  bootRuntime = appsRuntime(boot.app, boot.servers, "boot.test", 1);
  await bootRuntime.start();
  restarted = await bootSettled((r) => r.reason === "boot", 3);
}

// The slowest fixture in the file and needed by one test only: it is built
// from the file's first moment, beside the chain of deploys above, and the
// stories below wait for it with their own forges (#10244).
let booted: Promise<void> | undefined;
beforeAll(() => {
  booted = restartBoot();
  booted.catch(() => {}); // awaited, and so reported, by the stories below
});
afterAll(async () => {
  await booted?.catch(() => {});
  await bootRuntime?.stop();
  if (boot === undefined) return;
  await boot.runtime.stop();
  await stopAppsForge(boot);
});

/**
 * Everything below stands alone: each story on a forge of its own, or on
 * none, so they run side by side instead of one after another behind the
 * chain above (#10244). Every forge is built once, all of them at once, and
 * each story's own invariant sits at the top of its tests.
 */
describe.concurrent("apps: the stories that stand alone, side by side", () => {
  // ---- a preview whose copied data the build cannot read starts fresh (issue #36) ----

  // Never checks in, so `install` has nothing to do: the deploy starts the
  // process directly, no `bun install` on the critical path.
  const RETRY_FORGE_JSON = JSON.stringify({
    app: { run: "sh run.sh", install: "", health: "/", ready: 5 },
  });
  // The forge whose previews start again on empty data.
  let reseed: AppsForge;
  /** A build that refuses data from a schema it does not know. */
  let schemaAhead: Deployed;
  /** A build that never comes up. */
  let alwaysFails: Deployed;

  // ---- a start failure is said in the app's own terms, not the forge's paths (issue #202) ----
  let leaky: AppsForge;

  // ---- the App page's terminal line survives an email-scanning edge (issue #254) ----
  let terminal: AppsForge;
  let terminalCookie: string;

  // ---- the forge's own restart never reads as this deploy's failure (issue #255) ----
  let stopping: AppsForge;

  beforeAll(async () => {
    await Promise.all([
      (async () => {
        reseed = await startAppsForge({ domain: "retry.test" });
        [schemaAhead, alwaysFails] = await Promise.all([
          deployApp(reseed, "schema-ahead", [
            { path: "forge.json", content: RETRY_FORGE_JSON },
            {
              path: "run.sh",
              content: `if [ -f "$FORGE_APP_DATA/schema-22" ]; then
  echo "database is at schema 22, this build only knows 21 - refusing to run" 1>&2
  exit 1
fi
exec bun -e "Bun.serve({port:Number(process.env.PORT),hostname:'127.0.0.1',fetch:()=>new Response('ok')})"
`,
            },
          ]),
          deployApp(reseed, "always-fails", [
            { path: "forge.json", content: RETRY_FORGE_JSON },
            { path: "run.sh", content: `echo "boom" 1>&2\nexit 1\n` },
          ]),
        ]);
      })(),
      (async () => {
        leaky = await startAppsForge({ domain: "leaky.test" });
      })(),
      (async () => {
        // Never started: the page's terminal line is under test, not a
        // deploy, so `beacon` is never built and nothing waits on it.
        terminal = await startAppsForge({ concurrency: 1, start: false });
        terminal.app.config.sshPort = 2222;
        terminal.app.config.sshHostKey =
          "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
        const made = await newApp(terminal.app, terminal.alice, {
          name: "beacon",
          description: "a light that stays on",
          visibility: "public",
        });
        if (!made.ok) throw new Error(String(made.error));
        giveHistory(terminal.app.db, getRepo(terminal.app.db, "alice", "beacon")!.id);
        terminalCookie = await signedInCookie(terminal.servers);
      })(),
      (async () => {
        stopping = await startAppsForge({ domain: "stop-mid-deploy.test" });
      })(),
      booted,
    ]);
  }, 90_000);

  afterAll(async () => {
    for (const forge of [reseed, leaky, terminal, stopping]) {
      if (forge === undefined) continue;
      await forge.runtime.stop();
      await stopAppsForge(forge);
    }
  });

  test("a build too old for a migration on main comes up on the retry", async () => {
    // Invariant: a preview whose copied data its build refuses starts again on empty data, and serves.
    const { repo, record, production } = schemaAhead;
    expect(production.state).toBe("ok");

    // A migration lands on `main` — simulated here the way the issue
    // describes it, a schema file production now has that an older build
    // does not know how to read.
    writeFileSync(
      join(envDataDir(reseed.dataDir, record.id, "production"), "schema-22"),
      "22",
    );

    const pull = await openNote(reseed, repo);
    const run = await deploySettled(
      reseed.app,
      repo.id,
      (r) => r.env === `pull-${pull.number}`,
    );
    expect(run.state).toBe("ok");

    const { lines } = readRunLog(reseed.dataDir, run.id);
    const text = lines.join("\n");
    expect(text).toMatch(/data: (copied|cloned) from production/);
    expect(text).toContain("exited with code 1 before answering");
    expect(text).toContain(
      "the copied data was not usable by this build; the preview is starting on empty data",
    );
    expect(text).toContain(`serving http://`);

    // The retry's data directory does not carry the discarded copy's file.
    const previewData = envDataDir(
      reseed.dataDir,
      record.id,
      previewEnv(pull.number),
    );
    expect(existsSync(join(previewData, "schema-22"))).toBe(false);

    const page = await fetch(`${reseed.servers.url}/`, {
      headers: { host: `schema-ahead--${pull.number}.retry.test` },
    });
    expect(page.status).toBe(200);
  }, 60_000);

  test("an app that always exits retries exactly once in a preview, and never in production", async () => {
    // Invariant: the empty-data retry happens once, only for a preview's copied data; production is never retried.
    const { repo, production } = alwaysFails;
    // Production: seeded empty, never a copy, so it gets exactly one try.
    expect(production.state).toBe("failed");
    const prodLog = readRunLog(reseed.dataDir, production.id).lines;
    expect(prodLog.filter((l) => l.startsWith("$ sh run.sh")).length).toBe(1);
    expect(prodLog.some((l) => l.includes("starting on empty data"))).toBe(
      false,
    );

    const pull = await openNote(reseed, repo);
    const run = await deploySettled(
      reseed.app,
      repo.id,
      (r) => r.env === `pull-${pull.number}`,
    );
    expect(run.state).toBe("failed");
    const previewLog = readRunLog(reseed.dataDir, run.id).lines;
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

  test("a deploy whose app throws on import names its own file, never the forge's data directory or the app's id", async () => {
    // Invariant: a start failure's error, summary, log and page carry the app's own path, never the forge's (issue #202).
    const { repo, record, production: run } = await deployApp(leaky, "throws", [
      {
        path: "forge.json",
        content: JSON.stringify({
          app: {
            run: "bun run src/server.ts",
            install: "",
            health: "/",
            ready: 3,
          },
        }),
      },
      { path: "src/server.ts", content: `throw new Error("boom");\n` },
    ]);
    expect(run.state).toBe("failed");

    const notForgePaths = (text: string): void => {
      expect(text).not.toContain(leaky.dataDir);
      expect(text).not.toContain(record.id);
    };

    // The error the runtime stores — the same one a run's summary and the
    // studio's head card both draw from — is the thrown message (issue
    // #270), not a stack frame; it never leaks the forge's own paths either.
    const status = leaky.runtime.envStatus(record, "production");
    expect(status?.error ?? "").toContain("boom");
    notForgePaths(status?.error ?? "");
    expect(run.summary ?? "").toContain("boom");
    notForgePaths(run.summary ?? "");

    // The full log still has the frame, path-stripped down to the app's
    // own file rather than the forge's data directory or the app's id.
    const { lines } = readRunLog(leaky.dataDir, run.id);
    const log = lines.join("\n");
    expect(log).toContain("src/server.ts");
    notForgePaths(log);

    // The studio's app page renders the same error in its head, for a
    // reader who never asked to see the forge's own filesystem.
    const cookie = await signedInCookie(leaky.servers);
    const page = await fetch(
      `${leaky.servers.url}/${repo.ownerName}/${repo.name}`,
      { headers: { cookie: `${cookie}; forge_mode=studio` } },
    );
    expect(page.status).toBe(200);
    notForgePaths(await page.text());
  }, 60_000);

  test("a deploy whose install runs past limits.time says so in one line on the app page", async () => {
    // Invariant: a build stopped by its time limit fails the deploy with that sentence, in the summary, the status and the app page (#10527).
    const { repo, record, production: run } = await deployApp(leaky, "slow-build", [
      {
        path: "forge.json",
        content: JSON.stringify({
          app: { run: "sh run.sh", install: "sleep 30", health: "/", ready: 3, limits: { time: 1 } },
        }),
      },
      { path: "run.sh", content: "exit 1\n" },
    ]);
    expect(run.state).toBe("failed");
    const sentence = "the build used its 1 second";
    expect(run.summary ?? "").toContain(sentence);
    expect(leaky.runtime.envStatus(record, "production")?.error ?? "").toContain(sentence);
    const cookie = await signedInCookie(leaky.servers);
    const page = await fetch(`${leaky.servers.url}/${repo.ownerName}/${repo.name}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(sentence);
  }, 60_000);

  /**
   * Issue #254: the terminal command has a `login@host` in it, which an
   * email-scanning edge on the forge's own domain rewrites into a `mailto:`
   * link — the one line a reader must copy character for character, turned
   * into something that neither shows the login nor copies as text.
   * `terminalLine` (`src/web/ui.ts`) now wraps it in the `<!--email_off-->`
   * marker such scanners honour, which leaves the command itself — the thing
   * a paste must carry — untouched.
   */
  test("the command sits between email_off markers, and the visible text is still the exact line", async () => {
    // Invariant: the App page's terminal command is wrapped in email_off markers and is otherwise the exact line.
    const res = await fetch(`${terminal.servers.url}/alice/beacon/app`, {
      headers: { cookie: terminalCookie },
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

  test("an install still in flight when the runtime stops finishes cancelled, not failed", async () => {
    // Invariant: a deploy the forge's own stop interrupts is cancelled with STOPPED_SUMMARY, worded as a restart, never failed (issue #255).
    const { app, alice, dataDir, servers, runtime } = stopping;
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
      await Bun.sleep(10);
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
    const cookie = await signedInCookie(servers);
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

  // ---- a start that fails reports the message, not its last line (issue #270) ----
  const crashManifest: AppManifest = {
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
    // Invariant: a failed start's error is the crash's message line, not its frames or the runtime's banner.
    const dir = await mkdtemp(join(tmpdir(), "forge-crash-"));
    try {
      const started = await startProcess({
        dir,
        dataDir: dir,
        manifest: { ...crashManifest, run: `printf '%s' '${CRASH}' 1>&2; exit 1` },
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

  // ---- the stopwatch a deploy's log reads from (issue #296) ----
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

  test("both productions answer before the preview, and the log says where the time went", async () => {
    // Invariant: at boot every app's production is reconciled before any preview, and the log times each stage (issue #296).
    expect(restarted.every((r) => r.state === "ok")).toBe(true);
    const order = [...restarted]
      .sort((a, b) => Date.parse(a.servingAt!) - Date.parse(b.servingAt!))
      .map((r) => (r.env === "production" ? "production" : "preview"));
    expect(order).toEqual(["production", "production", "preview"]);

    const production = restarted.find((r) => r.env === "production")!;
    const text = readRunLog(boot.dataDir, production.id).lines.join("\n");
    expect(text).toMatch(
      /timing: starting the process \d+\.\ds after the deploy started — turn \d+\.\ds · manifest \d+\.\ds · checkout \d+\.\ds · data \d+\.\ds · setup \d+\.\ds/,
    );
    expect(text).toMatch(
      /timing: answered \d+\.\ds after the process was started/,
    );
  }, 90_000);

  // ---- start: a port lost to another process ----
  const portManifest: AppManifest = {
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
      manifest: { ...portManifest, ...over },
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
    // Invariant: a start that loses its port to another process is started again on a fresh port.
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
    // Invariant: a start is tried at most PORT_RETRIES more times, however many ports are taken.
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
    // Invariant: only a lost port earns another start; any other exit fails at once.
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
