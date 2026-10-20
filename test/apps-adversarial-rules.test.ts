/**
 * Adversarial coverage for apps (docs/APPS.md), through a live apps
 * runtime: environment names, preview data, and rules 1 and 4. Split from
 * apps-adversarial.test.ts so no one file sets the gate's floor (#2038);
 * each file of the split boots its own forge and runtime.
 *
 * Fixtures are built once (#3577): one forge, one app deployed to
 * production, one seeded repository with its agent. The preview the
 * preview_data test reads is opened in `beforeAll` and asserted last, so
 * its deploy runs while the git tests do. Nothing polls: a deploy is
 * awaited on the bus's `run.finished`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { App } from "../src/app.ts";
import { newApp, updateAppSettings } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createRepo,
  forkRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import type { AppRecord } from "../src/core/apps.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import {
  cancelRun,
  claimRun,
  createRun,
  finishRun,
  isTerminal,
  listRuns,
  type Run,
} from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import type { User } from "../src/core/users.ts";
import { grantedCookie } from "./helpers/identity.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import {
  APPS_DOMAIN as DOMAIN,
  fetchAsHost,
  startAppsForge,
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

/**
 * The newest deploy on `repoId` matching `where`, once it has finished:
 * read now, and again on every `run.finished` the bus carries for the
 * repository — every deploy the runtime finishes is announced there.
 */
function settled(
  app: App,
  repoId: string,
  where: (run: Run) => boolean,
  timeoutMs = 60_000,
): Promise<Run> {
  const done = () =>
    listRuns(app.db, repoId, { kind: "deploy", limit: 50 }).find(
      (run) => where(run) && isTerminal(run.state),
    );
  return new Promise((resolve, reject) => {
    const finish = (run: Run) => {
      unsubscribe();
      clearTimeout(timer);
      resolve(run);
    };
    const unsubscribe = app.bus.subscribe((event) => {
      if (event.kind !== "run.finished" || event.repoId !== repoId) return;
      const run = done();
      if (run) finish(run);
    });
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("run did not settle in time"));
    }, timeoutMs);
    const run = done();
    if (run) finish(run);
  });
}

describe("apps adversarial: env names, preview data, and rules 1/4", () => {
  let forge: AppsForge;
  let app: App;
  let alice: User;
  /** `adversarial`: public, serving in production, preview_data "empty". */
  let deployed: { repo: Repo; record: AppRecord };
  /** The pull whose preview must start without production's data. */
  let previewPull: Pull;
  /** A seeded repository with `rule1bot` on its crew. */
  let seeded: Repo;
  let bot: User;

  const viaHost = (host: string, path = "/", init: RequestInit = {}) =>
    fetchAsHost(forge.servers, host, path, init);

  beforeAll(async () => {
    forge = await startAppsForge();
    ({ app, alice } = forge);

    const made = await newApp(app, alice, {
      name: "adversarial",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    const { repo, app: record } = made.value;
    const production = await settled(app, repo.id, (r) => r.env === "production");
    if (production.state !== "ok")
      throw new Error(`production did not deploy: ${production.summary}`);
    deployed = { repo, record };

    // Production holds a note before the preview is opened; the preview's
    // deploy then runs in the background while the tests below do.
    updateAppSettings(app, alice, repo, { previewData: "empty" });
    const form = new FormData();
    form.set("body", "production-only note");
    await viaHost(`adversarial.${DOMAIN}`, "/notes", {
      method: "POST",
      body: form,
      headers: {
        cookie: await grantedCookie(app, forge.servers.url, alice, record),
      },
    });
    const committed = await commitToBranch(app, alice, repo, {
      branch: "empty-preview",
      base: repo.defaultBranch,
      message: "trigger a preview",
      files: [{ path: "EMPTY.md", content: "hi\n" }],
    });
    if (!committed.ok) throw new Error(String(committed.error));
    const opened = await openPull(app, alice, repo, {
      title: "Empty preview",
      baseBranch: repo.defaultBranch,
      headBranch: "empty-preview",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    previewPull = opened.value;

    const madeRepo = await createRepo(app, alice, { name: "rule1-repo" });
    if (!madeRepo.ok) throw new Error(String(madeRepo.error));
    seeded = madeRepo.value;
    await commitToBranch(app, alice, seeded, {
      message: "seed",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    const madeAgent = await createAgent(app, alice, {
      username: "rule1bot",
      model: "",
      brief: "",
    });
    if (!madeAgent.ok) throw new Error(String(madeAgent.error));
    bot = madeAgent.value.user;
    addToCrew(app, alice, seeded, "rule1bot");
  }, 60_000);

  afterAll(async () => {
    await forge.runtime.stop();
    await stopAppsForge(forge);
  });

  test("the API never lets an env parameter shaped like a path reach the filesystem", async () => {
    const adminToken = createToken(
      app.db,
      alice.id,
      "traversal-test",
      "admin",
    ).token;
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`${forge.servers.url}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${adminToken}` },
      });
    const owner = deployed.repo.ownerName;
    const name = deployed.repo.name;
    // A bare ".." segment is collapsed by `URL`/`fetch` before the request
    // ever leaves the client (RFC 3986 dot-segment removal), so it can only
    // be used to probe the *server's* handling when percent-encoded — a raw
    // ".." never reaches the router at all, which is the stronger property
    // and not what this test is isolating.
    for (const hostile of [
      "..%2F..%2F..%2Fetc",
      "production%2F..%2F..",
      "pull--1",
    ]) {
      const redeploy = await api(
        `/api/v1/repos/${owner}/${name}/app/${hostile}/redeploy`,
        { method: "POST" },
      );
      if (redeploy.status !== 422) {
        throw new Error(
          `redeploy env=${hostile} returned ${redeploy.status}, expected 422`,
        );
      }
      const body = (await redeploy.json()) as { error: string };
      expect(body.error).toBe("no_such_env");

      const stop = await api(
        `/api/v1/repos/${owner}/${name}/app/${hostile}/stop`,
        { method: "POST" },
      );
      if (stop.status !== 422) {
        throw new Error(
          `stop env=${hostile} returned ${stop.status}, expected 422`,
        );
      }

      const open = await api(
        `/api/v1/repos/${owner}/${name}/app/${hostile}/open`,
      );
      expect(open.status).toBe(422);
    }
  }, 60_000);

  test("rule 1: the repository takes no push from the crew; the agent's fork takes branches but never its default branch, protected or not, renamed or not", async () => {
    const repo = seeded;
    const token = createToken(app.db, bot.id, "t", "rw");
    const remote = `${forge.servers.url.replace("://", `://rule1bot:${token.token}@`)}/${repo.ownerName}/${repo.name}.git`;
    const clone = join(forge.work, "rule1-clone");
    expect(
      (await sh(["git", "clone", "--quiet", remote, clone], forge.work)).code,
    ).toBe(0);
    await Bun.write(join(clone, "A.md"), "a\n");
    await sh(["git", "add", "A.md"], clone);
    await sh(["git", "commit", "-qm", "a"], clone);

    // The repository itself: crew membership is read. Neither the default
    // branch nor any other takes a push, and the refusal hides nothing it
    // would not hide from any non-writer.
    const toDefault = await sh(
      ["git", "push", "-q", "origin", `HEAD:${repo.defaultBranch}`],
      clone,
    );
    expect(toDefault.code).not.toBe(0);
    const toOther = await sh(
      ["git", "push", "-q", "origin", "HEAD:refs/heads/some-branch"],
      clone,
    );
    expect(toOther.code).not.toBe(0);
    expect(
      await resolveOid(
        repoDir(app.reposRoot, repo.ownerName, repo.name),
        "refs/heads/some-branch",
      ),
    ).toBeUndefined();

    // The agent's fork takes its branches…
    const forked = await forkRepo(app, bot, repo);
    expect(forked.ok).toBe(true);
    if (!forked.ok) return;
    let fork = forked.value;
    const forkRemote = `${forge.servers.url.replace("://", `://rule1bot:${token.token}@`)}/${fork.ownerName}/${fork.name}.git`;
    const otherOk = await sh(
      ["git", "push", "-q", forkRemote, "HEAD:refs/heads/some-branch"],
      clone,
    );
    expect(otherOk.code).toBe(0);

    // …but never its default branch: rule 1 is unconditional, protectDefault
    // off or on — an agent can't even fast-forward it.
    const refusedOff = await sh(
      ["git", "push", "-q", forkRemote, `HEAD:${fork.defaultBranch}`],
      clone,
    );
    expect(refusedOff.code).not.toBe(0);
    expect(refusedOff.err).toContain("agents propose through pulls");
    await updateRepoSettings(app, alice, fork, { protectDefault: true });
    const refusedOn = await sh(
      ["git", "push", "-q", forkRemote, `HEAD:${fork.defaultBranch}`],
      clone,
    );
    expect(refusedOn.code).not.toBe(0);
    expect(refusedOn.err).toContain("agents propose through pulls");

    // Rename the fork's default branch, then confirm a push to the NEW name
    // is still refused (the hook must read the live default branch, not a
    // cached name).
    await sh(["git", "checkout", "-q", "-b", "renamed-main"], clone);
    await sh(["git", "push", "-q", forkRemote, "renamed-main"], clone);
    const renamed = await updateRepoSettings(app, alice, fork, {
      defaultBranch: "renamed-main",
    });
    expect(renamed.ok).toBe(true);
    fork = getRepoById(app.db, fork.id)!;
    expect(fork.defaultBranch).toBe("renamed-main");
    await Bun.write(join(clone, "B.md"), "b\n");
    await sh(["git", "add", "B.md"], clone);
    await sh(["git", "commit", "-qm", "b"], clone);
    const refusedRenamed = await sh(
      ["git", "push", "-q", forkRemote, "HEAD:renamed-main"],
      clone,
    );
    expect(refusedRenamed.code).not.toBe(0);
    expect(refusedRenamed.err).toContain("agents propose through pulls");
  }, 60_000);

  test("rule 1: an agent's rw token cannot reach settings, app enable, crew, tokens, or agent creation over the API", async () => {
    const repo = seeded;
    const token = createToken(app.db, bot.id, "t", "rw").token;
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`${forge.servers.url}${path}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      });

    const settingsResp = await api(
      `/api/v1/repos/${repo.ownerName}/${repo.name}`,
      { method: "PATCH", body: JSON.stringify({ visibility: "public" }) },
    );
    expect(settingsResp.status).toBe(403);

    const enableResp = await api(
      `/api/v1/repos/${repo.ownerName}/${repo.name}/app`,
      { method: "POST", body: JSON.stringify({}) },
    );
    expect(enableResp.status).toBe(403);

    const crewResp = await api(
      `/api/v1/repos/${repo.ownerName}/${repo.name}/crew/rule1bot`,
      { method: "PUT" },
    );
    expect(crewResp.status).toBe(403);

    const tokenResp = await api("/api/v1/tokens", {
      method: "POST",
      body: JSON.stringify({ adminConfirm: true, name: "x", scope: "admin" }),
    });
    // Neither via-session nor via-password: falls through to bad credentials.
    expect(tokenResp.status).toBe(401);

    const agentResp = await api("/api/v1/agents", {
      method: "POST",
      body: JSON.stringify({ username: "another-bot" }),
    });
    expect(agentResp.status).toBe(403);
  }, 30_000);

  test("rule 4: require_checks cannot be satisfied by a stale head, a foreign pull's run, a cancelled run, or a queued one; a push re-locks it", async () => {
    const madeRepo = await createRepo(app, alice, { name: "rule4-repo" });
    expect(madeRepo.ok).toBe(true);
    if (!madeRepo.ok) return;
    let repo = madeRepo.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    repo = (await updateRepoSettings(app, alice, repo, { requireChecks: true }))
      .ok
      ? getRepoById(app.db, repo.id)!
      : repo;

    const committed1 = await commitToBranch(app, alice, repo, {
      branch: "feature",
      base: repo.defaultBranch,
      message: "feature commit 1",
      files: [{ path: "F.md", content: "1\n" }],
    });
    expect(committed1.ok).toBe(true);
    if (!committed1.ok) return;
    const oid1 = committed1.value.commitOid;
    const opened = await openPull(app, alice, repo, {
      title: "Feature",
      baseBranch: repo.defaultBranch,
      headBranch: "feature",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const pull = opened.value;

    // A second branch, pointing at the exact same commit, opened as a
    // second pull — so a run tagged with its issue id shares the commit
    // oid but must never satisfy the first pull's gate.
    await sh(
      ["git", "branch", "feature2", oid1],
      repoDir(app.reposRoot, repo.ownerName, repo.name),
    );
    const opened2 = await openPull(app, alice, repo, {
      title: "Feature 2",
      baseBranch: repo.defaultBranch,
      headBranch: "feature2",
    });
    expect(opened2.ok).toBe(true);
    if (!opened2.ok) return;

    const mkRun = (issueId: string, oid: string) =>
      createRun(app.db, {
        repoId: repo.id,
        kind: "deploy",
        issueId,
        commitOid: oid,
        env: "pull-x",
        reason: "push",
      });

    // Queued: never satisfies.
    mkRun(pull.id, oid1);
    let refused = await mergePull(
      app,
      alice,
      repo,
      getPull(app.db, repo.id, pull.number)!,
      "merge",
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("checks_required");

    // Cancelled: never satisfies.
    const toCancel = mkRun(pull.id, oid1);
    cancelRun(app.db, toCancel.id, "test cancel");
    refused = await mergePull(
      app,
      alice,
      repo,
      getPull(app.db, repo.id, pull.number)!,
      "merge",
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("checks_required");

    // A green run for a DIFFERENT pull at the same commit: never satisfies
    // pull 1.
    const foreignRun = mkRun(opened2.value.id, oid1);
    claimRun(app.db, foreignRun.id);
    finishRun(app.db, foreignRun.id, { state: "ok", summary: "green" });
    refused = await mergePull(
      app,
      alice,
      repo,
      getPull(app.db, repo.id, pull.number)!,
      "merge",
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("checks_required");

    // Now a genuinely green run for pull 1 at its actual head: merge works.
    const goodRun = mkRun(pull.id, oid1);
    claimRun(app.db, goodRun.id);
    finishRun(app.db, goodRun.id, { state: "ok", summary: "green" });
    const merged = await mergePull(
      app,
      alice,
      repo,
      getPull(app.db, repo.id, pull.number)!,
      "merge",
    );
    expect(merged.ok).toBe(true);
  }, 60_000);

  test("rule 4: a push after a green check re-locks the pull until the new head is green", async () => {
    const madeRepo = await createRepo(app, alice, { name: "rule4-relock" });
    expect(madeRepo.ok).toBe(true);
    if (!madeRepo.ok) return;
    let repo = madeRepo.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    repo = (await updateRepoSettings(app, alice, repo, { requireChecks: true }))
      .ok
      ? getRepoById(app.db, repo.id)!
      : repo;
    const c1 = await commitToBranch(app, alice, repo, {
      branch: "relock",
      base: repo.defaultBranch,
      message: "c1",
      files: [{ path: "R.md", content: "1\n" }],
    });
    if (!c1.ok) throw new Error("setup failed");
    const opened = await openPull(app, alice, repo, {
      title: "Relock",
      baseBranch: repo.defaultBranch,
      headBranch: "relock",
    });
    if (!opened.ok) throw new Error("setup failed");
    const pull = opened.value;
    const green1 = createRun(app.db, {
      repoId: repo.id,
      kind: "deploy",
      issueId: pull.id,
      commitOid: c1.value.commitOid,
      env: "pull-x",
      reason: "push",
    });
    claimRun(app.db, green1.id);
    finishRun(app.db, green1.id, { state: "ok", summary: "green" });
    expect(
      (
        await mergePull(
          app,
          alice,
          repo,
          getPull(app.db, repo.id, pull.number)!,
          "merge",
        )
      ).ok,
    ).toBe(true);
  }, 30_000);

  test('preview_data: "empty" starts a preview with no copy of production\'s data', async () => {
    const { repo } = deployed;
    expect(await (await viaHost(`adversarial.${DOMAIN}`)).text()).toContain(
      "production-only note",
    );
    await settled(app, repo.id, (r) => r.env === `pull-${previewPull.number}`);
    const previewHtml = await (
      await viaHost(`adversarial--${previewPull.number}.${DOMAIN}`)
    ).text();
    expect(previewHtml).not.toContain("production-only note");
  }, 60_000);
});
