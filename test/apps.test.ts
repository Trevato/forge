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
import { envDataDir, envDir, previewEnv } from "../src/apps/data.ts";
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
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { readRunLog } from "../src/runs/log.ts";
import { grantedCookie } from "./helpers/identity.ts";

const clientEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Agent",
  GIT_AUTHOR_EMAIL: "agent@forge.local",
  GIT_COMMITTER_NAME: "Agent",
  GIT_COMMITTER_EMAIL: "agent@forge.local",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

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
                test: "sleep 3 && bun test",
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
    // It answered well inside the test step's own sleep.
    expect(Date.now() - start).toBeLessThan(3_000);

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

  test("a restart rebuilds production and the open previews from git", async () => {
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
    // No push asked for this one, so it carries no push instant to claim:
    // a boot reconcile is worded from the deploy's own start.
    const booted = runtime.envStatus(record, "production");
    expect(booted?.createdAt).toBeUndefined();
    expect(booted?.deployStartedAt).toBeDefined();
    const openPreviews = listRuns(app.db, repo.id, { kind: "deploy" }).filter(
      (r) => r.reason === "boot" && r.env !== "production",
    );
    expect(openPreviews.length).toBe(1); // the bot's pull is the one open pull
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

    const production = await settled(
      (r) => r.env === "production",
      repo.id,
    );
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
    expect(text).toContain("data: copied from production");
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
    expect(
      prodLog.some((l) => l.includes("starting on empty data")),
    ).toBe(false);

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
    expect(
      previewLog.filter((l) => l.startsWith("$ sh run.sh")).length,
    ).toBe(2);
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

  test("a plan naming an agent not on the forge is refused; nothing changes", async () => {
    const made = await newApp(app, alice, {
      name: "notes-b",
      description: "BAD-AGENT: pick someone who does not exist",
      pickAgent: true,
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.plan).toBeUndefined();
    expect(made.value.issue).toBeUndefined();
    const crew = listCrew(app, alice, made.value.repo);
    expect(crew.ok && crew.value.length).toBe(0);
  });

  test("a plan that times out changes nothing", async () => {
    const made = await newApp(app, alice, {
      name: "notes-c",
      description: "HANG-ME: never answer",
      pickAgent: true,
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.value.plan).toBeUndefined();
    expect(made.value.issue).toBeUndefined();
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
    expect(made.value.issue).toBeUndefined();
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
    expect(made.value.issue).toBeUndefined();
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

  test("a sentence alone creates an app named its slug", async () => {
    const res = await submitNewApp({
      description: "Keep a shared grocery list",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "/nadia/keep-a-shared-grocery-list",
    );
  });

  test("a second app from the same sentence gets a distinct name", async () => {
    const res = await submitNewApp({
      description: "Keep a shared grocery list",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "/nadia/keep-a-shared-grocery-list-2",
    );
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

  test("in dev mode, POST /apps/new redirects to dev's app page, chosen from ctx.mode", async () => {
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
    expect(submitted.headers.get("location")).toBe("/priya/tracker/app");
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
