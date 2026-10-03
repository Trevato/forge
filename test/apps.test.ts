import { createHmac } from "node:crypto";
/**
 * Apps, end to end (docs/APPS.md): a new app runs in production seconds
 * after it exists; a pull gets a preview with a copy of production's data;
 * a push moves the preview; closing the pull removes it; a private app
 * answers only through a grant; `require_checks` holds the merge until the
 * head's deploy is green; and the crew rules cannot be got around.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { seconds, Stopwatch } from "../src/apps/timing.ts";
import { envDataDir, envDir, previewEnv } from "../src/apps/data.ts";
import { childEnv, runStep, startProcess } from "../src/apps/process.ts";
import type { AppManifest } from "../src/apps/manifest.ts";
import {
  enableApp,
  newApp,
  openEnvUrl,
  updateAppSettings,
} from "../src/actions/apps.ts";
import { addToCrew, createAgent, listCrew } from "../src/actions/crew.ts";
import {
  assignIssue,
  openIssue,
  setIssueState,
} from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { forkRepo } from "../src/actions/repos.ts";
import {
  commitToBranch,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import type { AppRecord } from "../src/core/apps.ts";
import { listEvents } from "../src/core/events.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepo, getRepoById, type Repo } from "../src/core/repos.ts";
import { resolveOid } from "../src/git/merge.ts";
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
import { gitClientEnv } from "./helpers/git-client.ts";

const clientEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "Agent",
  GIT_AUTHOR_EMAIL: "agent@forge.local",
  GIT_COMMITTER_NAME: "Agent",
  GIT_COMMITTER_EMAIL: "agent@forge.local",
});

async function sh(args: string[], cwd: string) {
  const proc = Bun.spawn(args, {
    cwd,
    env: clientEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

import { identityKey } from "../src/apps/proxy.ts";
import { scaffoldFiles } from "../src/apps/scaffold.ts";
import { parseCheck } from "../src/apps/manifest.ts";
import {
  appNameJs,
  deriveAppName,
  STOP_WORDS,
} from "../src/web/pages/apps-name.ts";
/** The scaffold's suites that boot its real `serve`: a test that swaps in a toy server drops them. */
const SERVER_SUITES = [
  "src/audit.test.ts",
  "src/openapi.test.ts",
  "src/security.test.ts",
];

describe("apps: production, previews, data, gates, crew", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let repo: Repo;
  let record: AppRecord;
  const DOMAIN = "apps.test";

  const viaHost = (host: string, path = "/", init: RequestInit = {}) =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), host },
      redirect: "manual",
    });

  /** Wait for the newest run matching `where` to finish, and return it. */
  async function settled(
    where: (run: Run) => boolean,
    timeoutMs = 60_000,
  ): Promise<Run> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = listRuns(app.db, repo.id, { kind: "deploy", limit: 50 }).find(
        where,
      );
      if (
        run &&
        (run.state === "ok" ||
          run.state === "failed" ||
          run.state === "cancelled")
      )
        return run;
      await Bun.sleep(100);
    }
    throw new Error("run did not settle in time");
  }

  const latest = (env: string) => (run: Run) => run.env === env;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-apps-"));
    work = await mkdtemp(join(tmpdir(), "forge-apps-work-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    // Every app the runtime boots is handed this key; the tests sign as
    // the forge would.
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 2,
    });
    await runtime.start();
    const created = await createUser(app.db, {
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
    await rm(work, { recursive: true, force: true });
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
    // A stranger is offered the forge's door; a signed identity is greeted.
    expect(html).toContain("/__forge/signin");
    const greeted = await (
      await viaHost(`hello.${DOMAIN}`, "/", {
        headers: {
          cookie: await grantedCookie(app, servers.url, alice, record),
        },
      })
    ).text();
    expect(greeted).toContain("<b>alice</b>");
    expect(greeted).toContain("/__forge/signout");
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
    const deadline = Date.now() + 10_000;
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

  test("require_checks holds the merge until the head's deploy is green", async () => {
    const settings = await updateRepoSettings(app, alice, repo, {
      requireChecks: true,
    });
    expect(settings.ok).toBe(true);
    repo = getRepoById(app.db, repo.id)!;
    const broken = await commitToBranch(app, alice, repo, {
      branch: "broken",
      base: repo.defaultBranch,
      message: "Break the test",
      files: [
        {
          path: "src/server.test.ts",
          content:
            'import { expect, test } from "bun:test";\ntest("fails", () => { expect(1).toBe(2); });\n',
        },
      ],
    });
    expect(broken.ok).toBe(true);
    const opened = await openPull(app, alice, repo, {
      title: "Broken",
      baseBranch: repo.defaultBranch,
      headBranch: "broken",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const failed = await settled(latest(`pull-${opened.value.number}`));
    expect(failed.state).toBe("failed");
    expect(failed.summary).toContain("test");
    const refused = await mergePull(app, alice, repo, opened.value, "merge");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("checks_required");
    // The app itself never broke, only its tests: the preview answers with
    // its own page rather than a gateway error, because a deployment that
    // answers is what was asked for.
    const page = await viaHost(`hello--${opened.value.number}.${DOMAIN}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(
      `preview of pull #${opened.value.number}`,
    );
    const status = runtime.envStatus(record, `pull-${opened.value.number}`);
    expect(status?.state).toBe("running");
    expect(status?.error).toContain("tests failed");

    const fixed = await commitToBranch(app, alice, repo, {
      branch: "broken",
      message: "Fix the test",
      files: [
        {
          path: "src/server.test.ts",
          content:
            'import { expect, test } from "bun:test";\ntest("passes", () => { expect(1).toBe(1); });\n',
        },
      ],
    });
    expect(fixed.ok).toBe(true);
    if (!fixed.ok) return;
    const green = await settled(
      (r) =>
        r.env === `pull-${opened.value.number}` &&
        r.commitOid === fixed.value.commitOid,
    );
    expect(green.state).toBe("ok");
    const merged = await mergePull(
      app,
      alice,
      repo,
      getPull(app.db, repo.id, opened.value.number)!,
      "merge",
    );
    expect(merged.ok).toBe(true);
  }, 120_000);

  test("a deploy whose test step sleeps: the preview answers before it finishes, and the run stays open until it does", async () => {
    const committed = await commitToBranch(app, alice, repo, {
      branch: "slow-test",
      base: repo.defaultBranch,
      message: "Slow test",
      files: [
        {
          path: "forge.json",
          content: `${JSON.stringify(
            {
              app: {
                run: "bun run src/server.ts",
                test: "sleep 8 && bun test",
                tty: "bun run src/tty.ts",
              },
            },
            null,
            2,
          )}\n`,
        },
      ],
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const opened = await openPull(app, alice, repo, {
      title: "Slow test",
      baseBranch: repo.defaultBranch,
      headBranch: "slow-test",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const start = Date.now();
    const deadline = start + 15_000;
    let answered = false;
    while (Date.now() < deadline) {
      if (
        (await viaHost(`hello--${opened.value.number}.${DOMAIN}`)).status ===
        200
      ) {
        answered = true;
        break;
      }
      await Bun.sleep(50);
    }
    expect(answered).toBe(true);
    // It answered well inside the test step's own sleep — with seconds to
    // spare, so a loaded machine cannot turn the margin into a race.
    expect(Date.now() - start).toBeLessThan(6_000);

    const status = runtime.envStatus(record, `pull-${opened.value.number}`);
    expect(status?.state).toBe("running");
    expect(status?.note).toContain("verifying its tests");

    const run = listRuns(app.db, repo.id, {
      env: `pull-${opened.value.number}`,
    }).find((r) => r.commitOid === committed.value.commitOid);
    expect(run?.state).toBe("running");
    // The deploy answered and swapped in well before its tests could have
    // finished, so `servingAt` is already recorded on the still-open run.
    expect(run?.servingAt).not.toBeNull();

    // The pull's push created this run: the status carries that instant, so
    // the words a page prints measure from the push and not from the permit
    // the gate handed out however much later.
    expect(status?.createdAt).toBe(run!.createdAt);
    expect(Date.parse(status!.deployStartedAt!)).toBeGreaterThanOrEqual(
      Date.parse(status!.createdAt!),
    );

    // `app.serving` published the same instant, with the tests it started
    // beside still going — this is what a preview's look is taken from.
    const serving = listEvents(app.db, { repoId: repo.id, limit: 200 }).find(
      (e) =>
        e.kind === "app.serving" &&
        e.payload["env"] === `pull-${opened.value.number}` &&
        e.payload["commitOid"] === committed.value.commitOid,
    );
    expect(serving).toBeDefined();
    expect(serving?.payload["servingAt"]).toBe(run?.servingAt);
    expect(serving?.payload["testsRunning"]).toBe(true);

    const done = await settled(
      (r) =>
        r.env === `pull-${opened.value.number}` &&
        r.commitOid === committed.value.commitOid,
    );
    expect(done.state).toBe("ok");
    expect(done.servingAt).not.toBeNull();
    expect(Date.parse(done.servingAt!)).toBeLessThan(
      Date.parse(done.finishedAt!),
    );

    // Close it out: a later test counts open previews and expects only the
    // one it opens itself.
    const merged = await mergePull(
      app,
      alice,
      repo,
      getPull(app.db, repo.id, opened.value.number)!,
      "merge",
    );
    expect(merged.ok).toBe(true);
  }, 30_000);
  test("identity: a granted person is named to the app, signed with the app's key; a client's own claim is dropped; the two doors work", async () => {
    // An app that says who it hears.
    const committed = await commitToBranch(app, alice, repo, {
      message: "Echo who is here",
      files: [
        // The app's own suites that boot its real server go with it.
        ...SERVER_SUITES.map((path) => ({ path, content: null })),
        {
          path: "src/server.ts",
          content: `Bun.serve({
  port: Number(process.env.PORT),
  hostname: "127.0.0.1",
  fetch(request) {
    return Response.json({
      identity: request.headers.get("x-forge-identity"),
      signature: request.headers.get("x-forge-signature"),
      key: process.env.FORGE_APP_IDENTITY_KEY ?? "",
    });
  },
});
`,
        },
      ],
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const run = await settled(
      (r) =>
        r.env === "production" && r.commitOid === committed.value.commitOid,
    );
    expect(run.state).toBe("ok");

    const link = openEnvUrl(app, alice, repo, "production", "/who");
    expect(link.ok).toBe(true);
    if (!link.ok) return;
    const url = new URL(link.value);
    const granted = await viaHost(url.host, `${url.pathname}${url.search}`);
    expect(granted.status).toBe(303);
    expect(granted.headers.get("location")).toBe("/who");
    const cookie = (granted.headers.get("set-cookie") ?? "").split(";")[0]!;

    // Named, and the signature verifies under the key the app was given.
    const heard = (await (
      await viaHost(`hello.${DOMAIN}`, "/who", {
        headers: {
          cookie,
          // A client's own claim never reaches the app.
          "x-forge-identity": "evil|mallory|admin|9999999999999",
          "x-forge-signature": "AAAA",
        },
      })
    ).json()) as { identity: string; signature: string; key: string };
    expect(heard.key).toBe(identityKey(dataDir, record.id));
    const [id, name, role, expires] = heard.identity.split("|");
    expect(id).toBe(alice.id);
    expect(name).toBe("alice");
    expect(role).toBe("admin"); // alice can write the repository
    expect(Number(expires)).toBeGreaterThan(Date.now());
    const expected = createHmac("sha256", heard.key)
      .update(heard.identity)
      .digest("base64url");
    expect(heard.signature).toBe(expected);

    // The doors: sign in goes to the forge and comes back to the page
    // asked for; sign out drops the grant.
    const signin = await viaHost(
      `hello.${DOMAIN}`,
      "/__forge/signin?to=/who%3Fq%3D1",
    );
    expect(signin.status).toBe(303);
    const open = new URL(signin.headers.get("location") ?? "");
    expect(open.pathname).toBe("/apps/open");
    expect(open.searchParams.get("host")).toBe(`hello.${DOMAIN}`);
    expect(open.searchParams.get("to")).toBe("/who?q=1");
    const signout = await viaHost(
      `hello.${DOMAIN}`,
      "/__forge/signout?to=//evil",
      {
        headers: { cookie },
      },
    );
    expect(signout.status).toBe(303);
    expect(signout.headers.get("location")).toBe("/");
    expect(signout.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
  }, 90_000);

  test("a deploy that never answers leaves servingAt null", async () => {
    const committed = await commitToBranch(app, alice, repo, {
      branch: "never-answers",
      base: repo.defaultBranch,
      message: "Never answers",
      files: [
        {
          path: "forge.json",
          content: `${JSON.stringify(
            { app: { run: "sleep 30", health: "/", ready: 1 } },
            null,
            2,
          )}\n`,
        },
      ],
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const opened = await openPull(app, alice, repo, {
      title: "Never answers",
      baseBranch: repo.defaultBranch,
      headBranch: "never-answers",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const failed = await settled(latest(`pull-${opened.value.number}`));
    expect(failed.state).toBe("failed");
    expect(failed.servingAt).toBeNull();
    // It never swapped in, so it never published the event a look is
    // taken from — the same reason it is pictureless.
    expect(
      listEvents(app.db, { repoId: repo.id, limit: 200 }).some(
        (e) =>
          e.kind === "app.serving" &&
          e.payload["env"] === `pull-${opened.value.number}`,
      ),
    ).toBe(false);

    // Close it — a pull that never comes up is not this test's to leave
    // open for the next one, which counts what git still has open.
    expect(setIssueState(app, alice, repo, opened.value, "closed").ok).toBe(
      true,
    );
  }, 20_000);

  test("the crew: an agent reads and writes its repo, never the default branch, never a merge", async () => {
    const made = await createAgent(app, alice, {
      username: "bot",
      model: "",
      brief: "Be brief.",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const bot = made.value.user;
    expect(bot.kind).toBe("agent");

    // Not on the crew: cannot be assigned, cannot see a private repo.
    const issue = openIssue(app, alice, repo, { title: "Do a thing" });
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;
    const early = assignIssue(app, alice, repo, issue.value, bot);
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.error).toBe("agent_not_on_crew");

    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
    const assigned = assignIssue(app, alice, repo, issue.value, bot);
    expect(assigned.ok).toBe(true);
    if (assigned.ok) expect(assigned.value.assigneeName).toBe("bot");
    // An agent starts no chain: it cannot assign, and it owns no new repos.
    const chain = assignIssue(app, bot, repo, issue.value, bot);
    expect(chain.ok).toBe(false);
    if (!chain.ok) expect(chain.error).toBe("forbidden");
    const owned = await createRepo(app, bot, { name: "mine" });
    expect(owned.ok).toBe(false);
    if (!owned.ok) expect(owned.error).toBe("forbidden_owner");

    // As the agent, over git: the repository itself takes nothing from it —
    // the crew works from forks. Its branch lands in its own fork, and the
    // pull proposes it back.
    const token = createToken(app.db, bot.id, "test", "rw");
    const remote = `${servers.url.replace("://", `://bot:${token.token}@`)}/${repo.ownerName}/${repo.name}.git`;
    const clone = join(work, "bot-clone");
    expect(
      (await sh(["git", "clone", "--quiet", remote, clone], work)).code,
    ).toBe(0);
    await Bun.write(join(clone, "BOT.md"), "made by bot\n");
    expect(
      (await sh(["git", "checkout", "-q", "-b", "bot/1-thing"], clone)).code,
    ).toBe(0);
    expect((await sh(["git", "add", "BOT.md"], clone)).code).toBe(0);
    expect((await sh(["git", "commit", "-qm", "bot work"], clone)).code).toBe(
      0,
    );
    const toRepo = await sh(
      ["git", "push", "-q", "origin", "bot/1-thing"],
      clone,
    );
    expect(toRepo.code).not.toBe(0);
    const forked = await forkRepo(app, bot, repo);
    expect(forked.ok).toBe(true);
    if (!forked.ok) return;
    const fork = forked.value;
    expect(fork.ownerName).toBe("bot");
    const forkRemote = `${servers.url.replace("://", `://bot:${token.token}@`)}/${fork.ownerName}/${fork.name}.git`;
    expect(
      (await sh(["git", "push", "-q", forkRemote, "bot/1-thing"], clone)).code,
    ).toBe(0);
    expect(
      await resolveOid(
        repoDir(app.reposRoot, repo.ownerName, repo.name),
        "refs/heads/bot/1-thing",
      ),
    ).toBeUndefined();

    // As the agent, a pull opens from the fork; merging it is not the
    // agent's to do.
    const proposed = await openPull(app, bot, repo, {
      title: "Bot work",
      baseBranch: repo.defaultBranch,
      headBranch: "bot/1-thing",
      headRepo: fork,
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.value.crossRepo).toBe(true);
    const refused = await mergePull(app, bot, repo, proposed.value, "merge");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("forbidden");
    // Its preview came up like anyone's, from the base's snapshot of the fork's branch.
    const run = await settled(latest(`pull-${proposed.value.number}`));
    expect(run.state).toBe("ok");
    expect(run.commitOid).toBe(proposed.value.headOid);

    // The agent pushes again, to its fork: the base's snapshot follows, and
    // so does the preview.
    await Bun.write(join(clone, "BOT.md"), "made by bot, twice\n");
    expect((await sh(["git", "commit", "-qam", "bot again"], clone)).code).toBe(
      0,
    );
    expect(
      (await sh(["git", "push", "-q", forkRemote, "bot/1-thing"], clone)).code,
    ).toBe(0);
    const again = (await sh(["git", "rev-parse", "HEAD"], clone)).out.trim();
    const redeployed = await settled(
      (r) => r.env === `pull-${proposed.value.number}` && r.commitOid === again,
    );
    expect(redeployed.state).toBe("ok");
    expect(
      await resolveOid(
        repoDir(app.reposRoot, repo.ownerName, repo.name),
        `refs/pull/${proposed.value.number}/head`,
      ),
    ).toBe(again);
  }, 120_000);

  test("a restart starts production warm and leaves the open preview asleep until asked for", async () => {
    await runtime.stop();
    // With no runtime there are no app hosts: the forge answers as itself.
    expect(await (await viaHost(`hello.${DOMAIN}`)).text()).not.toContain(
      "<h1>hello</h1>",
    );
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 2,
    });
    await runtime.start();
    const production = await settled(
      (r) => r.env === "production" && r.reason === "boot",
    );
    expect(production.state).toBe("ok");
    expect((await viaHost(`hello.${DOMAIN}`)).status).toBe(200);
    // The bot's pull is the one open pull: its preview came back asleep,
    // with no run spent, and the first request for it wakes it.
    // No push asked for this one, so it carries no push instant to claim:
    // a boot reconcile is worded from the deploy's own start.
    const booted = runtime.envStatus(record, "production");
    expect(booted?.createdAt).toBeUndefined();
    expect(booted?.deployStartedAt).toBeDefined();
    const openPreviews = listRuns(app.db, repo.id, { kind: "deploy" }).filter(
      (r) => r.reason === "boot" && r.env !== "production",
    );
    expect(openPreviews.length).toBe(0);
    const previews = runtime
      .status(record)
      .filter((e) => e.env !== "production");
    expect(previews.map((e) => e.state)).toEqual(["asleep"]);
    const openEnv = previews[0]!.env;
    const woke = await viaHost(`hello--${openEnv.slice(5)}.${DOMAIN}`, "/", {
      headers: {
        cookie: await grantedCookie(app, servers.url, alice, record, openEnv),
      },
    });
    expect(woke.status).toBe(200);
    expect(
      runtime.status(record).find((e) => e.env !== "production")?.state,
    ).toBe("running");
  }, 90_000);

  test("a push that cannot boot leaves the old deployment serving and names the push that failed (issue #200)", async () => {
    const before = runtime.envStatus(record, "production");
    expect(before?.state).toBe("running");
    const servingOid = before!.commitOid;
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const original =
      (await sh(["git", "show", `${repo.defaultBranch}:forge.json`], dir)).out +
      "\n";

    const broken = await commitToBranch(app, alice, repo, {
      message: "Break forge.json",
      files: [{ path: "forge.json", content: "{ not json" }],
    });
    expect(broken.ok).toBe(true);
    if (!broken.ok) return;
    const failed = await settled(
      (r) => r.env === "production" && r.commitOid === broken.value.commitOid,
    );
    expect(failed.state).toBe("failed");

    // The old deployment never moved: it still answers, at its own commit.
    const status = runtime.envStatus(record, "production");
    expect(status?.state).toBe("running");
    expect(status?.commitOid).toBe(servingOid);
    expect((await viaHost(`hello.${DOMAIN}`)).status).toBe(200);
    // But the failed push is named, not silently dropped.
    expect(status?.failedDeploy?.commitOid).toBe(broken.value.commitOid);
    expect(status?.failedDeploy?.runId).toBe(failed.id);
    expect(status?.failedDeploy?.error).toContain("forge.json");

    // A later successful deploy clears it: no permanent furniture.
    const fixed = await commitToBranch(app, alice, repo, {
      message: "Fix forge.json",
      files: [{ path: "forge.json", content: original }],
    });
    expect(fixed.ok).toBe(true);
    if (!fixed.ok) return;
    const ok = await settled(
      (r) => r.env === "production" && r.commitOid === fixed.value.commitOid,
    );
    expect(ok.state).toBe("ok");
    const cleared = runtime.envStatus(record, "production");
    expect(cleared?.commitOid).toBe(fixed.value.commitOid);
    expect(cleared?.failedDeploy).toBeUndefined();
  }, 90_000);
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
    const created = await createUser(app.db, {
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
    const created = await createUser(app.db, {
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

describe("New app: turn the sentence into a plan and pick the crew", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bot: string;
  let fakeClaude: string;
  let realClaude: string | undefined;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-plan-"));
    app = createApp({ dataDir, port: 0 });
    const created = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;
    const made = await createAgent(app, alice, {
      username: "bot",
      brief: "Be brief.",
    });
    if (!made.ok) throw new Error(String(made.error));
    bot = made.value.user.username;

    // A stand-in for `claude --output-format json`: one JSON object on
    // stdout, chosen by a marker in the prompt (which carries the sentence).
    fakeClaude = join(dataDir, "fake-claude");
    writeFileSync(
      fakeClaude,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
args="$*"
case "$args" in
  *HANG-ME*) sleep 30; exit 0 ;;
  *BAD-AGENT*) printf '%s\\n' '{"is_error":false,"result":"{\\"summary\\":\\"nope\\",\\"checklist\\":[\\"x\\"],\\"agent\\":\\"nobody-on-this-forge\\",\\"confidence\\":0.9}"}'; exit 0 ;;
esac
printf '%s\\n' '{"is_error":false,"result":"{\\"summary\\":\\"Build a notes app\\",\\"checklist\\":[\\"Set up storage\\",\\"Add a form\\",\\"Show the list\\"],\\"agent\\":\\"bot\\",\\"confidence\\":0.8}"}'
`,
    );
    chmodSync(fakeClaude, 0o755);
    realClaude = process.env["FORGE_CLAUDE"];
    process.env["FORGE_CLAUDE"] = fakeClaude;
  });

  afterAll(async () => {
    if (realClaude === undefined) delete process.env["FORGE_CLAUDE"];
    else process.env["FORGE_CLAUDE"] = realClaude;
    delete process.env["FORGE_APP_PLAN"];
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a good plan lands its checklist on the first issue and picks the agent", async () => {
    const made = await newApp(app, alice, {
      name: "notes-a",
      description: "Keep a list of notes",
      pickAgent: true,
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.plan?.agent).toBe(bot);
    expect(made.value.issue?.assigneeName).toBe(bot);
    expect(made.value.issue?.body).toContain("Build a notes app");
    expect(made.value.issue?.body).toContain("- [ ] Set up storage");
    expect(made.value.issue?.body).toContain("- [ ] Add a form");
  });

  test("a slug already in use is refused before any repository exists", async () => {
    const first = await newApp(app, alice, { name: "held-x" });
    expect(first.ok).toBe(true);
    const second = await newApp(app, alice, { name: "held_x" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("slug_taken");
    expect(getRepo(app.db, alice.username, "held_x")).toBeUndefined();
  });

  test("a plan naming an agent not on the forge is refused; the sentence still opens unassigned", async () => {
    const made = await newApp(app, alice, {
      name: "notes-b",
      description: "BAD-AGENT: pick someone who does not exist",
      pickAgent: true,
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.plan).toBeUndefined();
    expect(made.value.issue?.assigneeName).toBeNull();
    expect(made.value.issue?.body).toBe(
      "BAD-AGENT: pick someone who does not exist",
    );
    const crew = listCrew(app, alice, made.value.repo);
    expect(crew.ok && crew.value.length).toBe(0);
  });

  test("a plan that times out still opens the sentence, unassigned", async () => {
    const made = await newApp(app, alice, {
      name: "notes-c",
      description: "HANG-ME: never answer",
      pickAgent: true,
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.plan).toBeUndefined();
    expect(made.value.issue?.assigneeName).toBeNull();
    const crew = listCrew(app, alice, made.value.repo);
    expect(crew.ok && crew.value.length).toBe(0);
  }, 10_000);

  test("FORGE_APP_PLAN=0 behaves exactly as without pickAgent", async () => {
    process.env["FORGE_APP_PLAN"] = "0";
    const made = await newApp(app, alice, {
      name: "notes-d",
      description: "Keep a list of notes",
      pickAgent: true,
    });
    delete process.env["FORGE_APP_PLAN"];
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.plan).toBeUndefined();
    expect(made.value.issue?.assigneeName).toBeNull();
  });

  test("no claude on PATH behaves exactly as without pickAgent", async () => {
    const before = process.env["FORGE_CLAUDE"];
    process.env["FORGE_CLAUDE"] = join(dataDir, "no-such-binary");
    const made = await newApp(app, alice, {
      name: "notes-e",
      description: "Keep a list of notes",
      pickAgent: true,
    });
    process.env["FORGE_CLAUDE"] = before;
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.plan).toBeUndefined();
    expect(made.value.issue?.assigneeName).toBeNull();
  });

  test('agent: "" — nobody picked — still opens the sentence, unassigned', async () => {
    const made = await newApp(app, alice, {
      name: "notes-f",
      description: "Keep a list of notes",
      agent: "",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.issue?.title).toBe("Build notes-f");
    expect(made.value.issue?.body).toBe("Keep a list of notes");
    expect(made.value.issue?.assigneeName).toBeNull();
    expect(made.value.issue?.state).toBe("open");
    const crew = listCrew(app, alice, made.value.repo);
    expect(crew.ok && crew.value.length).toBe(0);
  });

  test("an empty sentence still opens nothing", async () => {
    const made = await newApp(app, alice, { name: "notes-g" });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.issue).toBeUndefined();
  });
});

describe("New app on a forge with no agents at all: the sentence still opens", () => {
  let dataDir: string;
  let app: App;
  let alice: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-noagents-"));
    app = createApp({ dataDir, port: 0 });
    const created = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the sentence opens the first issue, unassigned", async () => {
    const made = await newApp(app, alice, {
      name: "solo",
      description: "Keep a list of notes",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.issue?.title).toBe("Build solo");
    expect(made.value.issue?.body).toBe("Keep a list of notes");
    expect(made.value.issue?.assigneeName).toBeNull();
    expect(made.value.issue?.state).toBe("open");
  });
});

describe("New app: the form asks for the sentence, and names it (issue #60)", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-appname-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const created = await createUser(app.db, {
      username: "nadia",
      email: "nadia@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    cookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "nadia",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  function submitNewApp(fields: Record<string, string>) {
    return fetch(`${base}/apps/new`, {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({
        owner: "",
        name: "",
        visibility: "private",
        agent: "",
        ...fields,
      }),
      redirect: "manual",
    });
  }

  test("a sentence alone creates an app named its slug, articles dropped", async () => {
    const res = await submitNewApp({
      description: "Keep a shared grocery list",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/nadia/keep-shared");
  });

  test("a second app from the same sentence gets a distinct name", async () => {
    const res = await submitNewApp({
      description: "Keep a shared grocery list",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/nadia/keep-shared-2");
  });

  test("a sentence a slug cannot carry asks for a name, sentence intact", async () => {
    const res = await submitNewApp({ description: "!!! ??? ..." });
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).toContain("make a name from");
    expect(text).toContain("!!! ??? ...");
  });

  test("an explicit name wins over the derived one", async () => {
    const res = await submitNewApp({
      name: "groceries",
      description: "Keep a shared grocery list",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/nadia/groceries");
  });
});

describe("deriveAppName: a sentence yields a short, ordinary name (issue #186)", () => {
  const cases: Array<[string, string | undefined]> = [
    // Leading articles and small connecting words are dropped.
    ["a notepad that counts words", "notepad-counts"],
    ["an app for tracking my plants", "app-tracking"],
    // Already short: nothing to drop.
    ["logs", "logs"],
    // Only stop words: falls back to the window itself, never empty.
    ["the a of it", "the-a"],
    // A script this ASCII slug cannot carry: no usable name.
    ["猫を飼っています", undefined],
    // Punctuation only: unchanged from before.
    ["!!! ??? ...", undefined],
  ];

  for (const [sentence, expected] of cases) {
    test(`${JSON.stringify(sentence)} -> ${JSON.stringify(expected)}`, () => {
      expect(deriveAppName(sentence)).toBe(expected);
    });
  }

  test("appNameJs embeds the same stop words, window and cap as deriveAppName", () => {
    expect(appNameJs).toContain(JSON.stringify(Array.from(STOP_WORDS)));
  });
});

describe("New app lands on the app's page, not the flash (issue #133)", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let base: string;
  let cookie: string;
  const DOMAIN = "apps.test";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-redirect-"));
    app = createApp({ dataDir, port: 0 });
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
    const created = await createUser(app.db, {
      username: "priya",
      email: "priya@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    const madeAgent = await createAgent(app, created.value, {
      username: "bot",
      brief: "Be brief.",
    });
    if (!madeAgent.ok) throw new Error(String(madeAgent.error));
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

  test("in studio mode, POST /apps/new redirects to the studio's app page, which shows the name, the URL and the first issue", async () => {
    const submitted = await fetch(`${base}/apps/new`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({
        owner: "priya",
        name: "planner",
        description: "Plan a trip",
        visibility: "private",
        agent: "bot",
      }),
      redirect: "manual",
    });
    expect(submitted.status).toBe(303);
    expect(submitted.headers.get("location")).toBe("/priya/planner");
    const flash = (submitted.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(flash).toStartWith("forge_flash=");

    const landed = await fetch(`${base}${submitted.headers.get("location")}`, {
      headers: { cookie: `${cookie}; ${flash}` },
    });
    expect(landed.status).toBe(200);
    const html = await landed.text();
    expect(html).toContain("planner");
    expect(html).toContain(`planner.${DOMAIN}:${servers.port}`);
    expect(html).toContain("#1 is assigned to bot.");
  });

  test("in dev mode, POST /apps/new redirects to the repository's home, its strip carrying the URL", async () => {
    const submitted = await fetch(`${base}/apps/new`, {
      method: "POST",
      headers: { cookie: `${cookie}; forge_mode=dev`, origin: base },
      body: new URLSearchParams({
        owner: "priya",
        name: "tracker",
        description: "Track expenses",
        visibility: "private",
        agent: "bot",
      }),
      redirect: "manual",
    });
    expect(submitted.status).toBe(303);
    expect(submitted.headers.get("location")).toBe("/priya/tracker");
    const flash = (submitted.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(flash).toStartWith("forge_flash=");

    const landed = await fetch(`${base}${submitted.headers.get("location")}`, {
      headers: { cookie: `${cookie}; forge_mode=dev; ${flash}` },
    });
    expect(landed.status).toBe(200);
    const html = await landed.text();
    expect(html).toContain("tracker");
    expect(html).toContain(`http://tracker.${DOMAIN}:${servers.port}`);
    expect(html).toContain("#1 is assigned to bot.");
  });

  test("a reader who cannot see the app gets the forge's not-found", async () => {
    const anonymous = await fetch(`${base}/priya/planner/app`, {
      redirect: "manual",
    });
    expect(anonymous.status).toBe(404);
  });
});

describe("a new app's own words promise only the check the forge runs (issue #192)", () => {
  const files = scaffoldFiles({
    name: "hello",
    description: "A place for notes",
  });
  const content = (path: string): string => {
    const file = files.find((f) => f.path === path);
    if (file === undefined || typeof file.content !== "string")
      throw new Error(`scaffold has no text file at ${path}`);
    return file.content;
  };

  // A sentence that talks about both "check" and "pull" is a sentence
  // claiming the forge checks the pull — true only when forge.json declares
  // one (`check`), since an app's own `test` runs beside its deploy instead.
  const promisesACheck = (prose: string): boolean =>
    prose
      .split(/(?<=[.!?])\s+/)
      .some(
        (sentence) => /\bcheck/i.test(sentence) && /\bpull/i.test(sentence),
      );

  test("forge.json declares no separate check, and the prose does not claim one", () => {
    const checked = parseCheck(content("forge.json"), content("package.json"));
    expect(checked.ok).toBe(true);
    const declaresCheck = checked.ok && checked.value !== undefined;
    expect(declaresCheck).toBe(false);
    expect(promisesACheck(content("README.md"))).toBe(declaresCheck);
    expect(promisesACheck(content("AGENTS.md"))).toBe(declaresCheck);
  });

  test("the README and AGENTS.md agree on what app.test actually does", () => {
    for (const path of ["README.md", "AGENTS.md"]) {
      expect(content(path)).toContain("app.test");
      expect(content(path)).toMatch(/beside/);
    }
  });
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
    const created = await createUser(app.db, {
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
    expect(withoutMarkers).toContain(`<code class="mono">${command}</code>`);
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
    const created = await createUser(app.db, {
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
    const created = await createUser(app.db, {
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
