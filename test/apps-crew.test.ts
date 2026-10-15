/**
 * Apps: the crew rules cannot be got around; a restart starts production
 * warm; a push that cannot boot leaves the old deployment serving.
 * Starts from `hello` serving in production (`helpers/apps-forge.ts`);
 * split from `apps.test.ts` so each part runs apart (#1798).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { forkRepo } from "../src/actions/repos.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import type { AppRecord } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import type { User } from "../src/core/users.ts";
import type { Servers } from "../src/http/server.ts";
import { grantedCookie } from "./helpers/identity.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import {
  APPS_DOMAIN,
  deploySettled,
  fetchAsHost,
  startAppsForge,
  startHello,
  stopAppsForge,
  type AppsForge,
} from "./helpers/apps-forge.ts";

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

describe("apps: the crew, a restart, a push that cannot boot", () => {
  let forge: AppsForge;
  let work: string;
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
    ({ work, app, servers, runtime, alice } = forge);
    ({ repo, record } = await startHello(forge));
  }, 60_000);

  afterAll(async () => {
    await runtime.stop();
    await stopAppsForge(forge);
  });

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
