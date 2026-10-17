/**
 * Adversarial coverage for apps (docs/APPS.md), through a live apps
 * runtime: closing a preview or a pull while it is live or mid-deploy.
 * Split from apps-adversarial.test.ts so no one file sets the gate's floor
 * (#2038); each file of the split boots its own forge and runtime.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { envDir } from "../src/apps/data.ts";
import { newApp } from "../src/actions/apps.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { getPull } from "../src/core/pulls.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const DOMAIN = "apps.test";

describe("apps adversarial: teardown races", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;

  const viaHost = (host: string, path = "/", init: RequestInit = {}) =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), host },
      redirect: "manual",
    });

  async function settled(
    repoId: string,
    where: (run: Run) => boolean,
    timeoutMs = 60_000,
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

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-adv-"));
    work = await mkdtemp(join(tmpdir(), "forge-adv-work-"));
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
    await rm(work, { recursive: true, force: true });
  });

  test("closing an already-live preview does not resurrect it a few seconds later", async () => {
    const made = await newApp(app, alice, {
      name: "resurrect",
      visibility: "public",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const repo = made.value.repo;
    const record = made.value.app;
    await settled(repo.id, (r) => r.env === "production");

    const committed = await commitToBranch(app, alice, repo, {
      branch: "preview-branch",
      base: repo.defaultBranch,
      message: "preview change",
      files: [{ path: "PREVIEW.md", content: "hi\n" }],
    });
    expect(committed.ok).toBe(true);
    const opened = await openPull(app, alice, repo, {
      title: "Preview",
      baseBranch: repo.defaultBranch,
      headBranch: "preview-branch",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const pull = opened.value;

    // Wait for the preview to actually come up (live, not just queued).
    await settled(repo.id, (r) => r.env === `pull-${pull.number}`);
    expect((await viaHost(`resurrect--${pull.number}.${DOMAIN}`)).status).toBe(
      200,
    );

    const closed = await mergePull(
      app,
      alice,
      repo,
      getPull(app.db, repo.id, pull.number)!,
      "merge",
    );
    expect(closed.ok).toBe(true);

    // The teardown itself must remove the directory promptly.
    const goneDeadline = Date.now() + 10_000;
    while (
      existsSync(envDir(dataDir, record.id, `pull-${pull.number}`)) &&
      Date.now() < goneDeadline
    )
      await Bun.sleep(50);
    expect(existsSync(envDir(dataDir, record.id, `pull-${pull.number}`))).toBe(
      false,
    );

    // The bug: `watch()`'s exit handler mistook the deliberate stop for a
    // crash and scheduled a restart ~2s later (RESTART_BACKOFF_MS[0]). Wait
    // well past that window and confirm nothing came back — no directory,
    // no live process answering the preview's host, no new "restart" run.
    await Bun.sleep(3_500);
    expect(existsSync(envDir(dataDir, record.id, `pull-${pull.number}`))).toBe(
      false,
    );
    const stillGone = await viaHost(`resurrect--${pull.number}.${DOMAIN}`);
    expect(stillGone.status).toBe(404);
    expect(await stillGone.text()).toContain("is gone");
    const resurrectionRuns = listRuns(app.db, repo.id, {
      env: `pull-${pull.number}`,
    }).filter((r) => r.reason === "restart");
    expect(resurrectionRuns.length).toBe(0);
  }, 60_000);

  test("closing a pull mid-deploy still leaves no directory and no process", async () => {
    const made = await newApp(app, alice, {
      name: "midclose",
      visibility: "public",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const repo = made.value.repo;
    const record = made.value.app;
    await settled(repo.id, (r) => r.env === "production");

    const committed = await commitToBranch(app, alice, repo, {
      branch: "slow-branch",
      base: repo.defaultBranch,
      message: "a change",
      files: [{ path: "SLOW.md", content: "hi\n" }],
    });
    expect(committed.ok).toBe(true);
    const opened = await openPull(app, alice, repo, {
      title: "Slow",
      baseBranch: repo.defaultBranch,
      headBranch: "slow-branch",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const pull = opened.value;

    // Close it immediately — almost certainly while the deploy is still
    // installing/testing/starting, never having reached `live`.
    const closedQuickly = await mergePull(
      app,
      alice,
      repo,
      getPull(app.db, repo.id, pull.number)!,
      "merge",
    );
    expect(closedQuickly.ok).toBe(true);

    const deadline = Date.now() + 15_000;
    while (
      existsSync(envDir(dataDir, record.id, `pull-${pull.number}`)) &&
      Date.now() < deadline
    )
      await Bun.sleep(50);
    expect(existsSync(envDir(dataDir, record.id, `pull-${pull.number}`))).toBe(
      false,
    );
    await Bun.sleep(3_500);
    expect(existsSync(envDir(dataDir, record.id, `pull-${pull.number}`))).toBe(
      false,
    );
    expect((await viaHost(`midclose--${pull.number}.${DOMAIN}`)).status).toBe(
      404,
    );
  }, 60_000);
});
