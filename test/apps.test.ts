import { createHmac } from "node:crypto";
/**
 * Apps, end to end (docs/APPS.md): a new app runs in production seconds
 * after it exists; a pull gets a preview with a copy of production's data;
 * a push moves the preview; closing the pull removes it; a private app
 * answers only through a grant; `require_checks` holds the merge until the
 * head's deploy is green; and the crew rules cannot be got around.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { envDir } from "../src/apps/data.ts";
import { newApp, openEnvUrl, updateAppSettings } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { forkRepo } from "../src/actions/repos.ts";
import {
  commitToBranch,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import type { AppRecord } from "../src/core/apps.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

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
  }, 90_000);

  test("the proxy carries a form post; production data persists", async () => {
    const form = new FormData();
    form.set("body", "first note in production");
    const posted = await viaHost(`hello.${DOMAIN}`, "/notes", {
      method: "POST",
      body: form,
    });
    expect(posted.status).toBe(303);
    const html = await (await viaHost(`hello.${DOMAIN}`)).text();
    expect(html).toContain("first note in production");
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
    // The preview shows why instead of a gateway error.
    const page = await viaHost(`hello--${opened.value.number}.${DOMAIN}`);
    expect(page.status).toBe(502);
    expect(await page.text()).toContain("test");

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
    const openPreviews = listRuns(app.db, repo.id, { kind: "deploy" }).filter(
      (r) => r.reason === "boot" && r.env !== "production",
    );
    expect(openPreviews.length).toBe(1); // the bot's pull is the one open pull
  }, 90_000);
});
