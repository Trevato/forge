/**
 * Adversarial coverage for apps (docs/APPS.md), through a live apps
 * runtime: what a failing install and a closed pull's test step leave
 * behind. Split from apps-adversarial.test.ts so no one file sets the
 * gate's floor (#2038); each file of the split boots its own forge and
 * runtime.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { newApp } from "../src/actions/apps.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { getPull } from "../src/core/pulls.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const DOMAIN = "apps.test";

describe("apps adversarial: the install and test steps", () => {
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
    const created = await createUser(app.db, { trusted: true,
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

  test("install failing fails before test or start ever run — nothing from a half-installed tree", async () => {
    const made = await newApp(app, alice, {
      name: "badinstall",
      visibility: "public",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const repo = made.value.repo;
    await settled(repo.id, (r) => r.env === "production");

    const testMarker = join(work, `install-test-marker-${Date.now()}`);
    const runMarker = join(work, `install-run-marker-${Date.now()}`);
    const committed = await commitToBranch(app, alice, repo, {
      branch: "bad-install",
      base: repo.defaultBranch,
      message: "install fails",
      files: [
        {
          path: "forge.json",
          content: `${JSON.stringify(
            {
              app: {
                install: "exit 1",
                run: `touch ${runMarker} && bun run src/server.ts`,
                test: `touch ${testMarker} && bun test`,
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
      title: "Bad install",
      baseBranch: repo.defaultBranch,
      headBranch: "bad-install",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const failed = await settled(
      repo.id,
      (r) =>
        r.env === `pull-${opened.value.number}` &&
        r.commitOid === committed.value.commitOid,
    );
    expect(failed.state).toBe("failed");
    expect(failed.summary).toContain("install");
    // Neither `test` nor `run` ever executed.
    expect(existsSync(testMarker)).toBe(false);
    expect(existsSync(runMarker)).toBe(false);
    expect(
      (await viaHost(`badinstall--${opened.value.number}.${DOMAIN}`)).status,
    ).toBe(502);
  }, 60_000);

  test("closing a pull whose deploy already answered kills its still-running test step — no orphan `bun test`", async () => {
    const made = await newApp(app, alice, {
      name: "slowtest",
      visibility: "public",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const repo = made.value.repo;
    await settled(repo.id, (r) => r.env === "production");

    // A merge lands this same forge.json on the default branch and
    // production redeploys it too, running this same test step to
    // completion (nothing aborts a deploy that was never in flight when the
    // pull closed) — a marker keyed by $FORGE_APP_ENV keeps that legitimate
    // production run from being mistaken for the preview's orphan.
    const marker = join(work, `slowtest-marker-${Date.now()}`);
    const committed = await commitToBranch(app, alice, repo, {
      branch: "slow-test",
      base: repo.defaultBranch,
      message: "slow test",
      files: [
        {
          path: "forge.json",
          content: `${JSON.stringify(
            {
              app: {
                run: "bun run src/server.ts",
                test: `sleep 5 && touch ${marker}-$FORGE_APP_ENV`,
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

    // Wait for the app to answer — well before the test step's sleep ends.
    const upDeadline = Date.now() + 10_000;
    let up = false;
    while (Date.now() < upDeadline) {
      if (
        (await viaHost(`slowtest--${opened.value.number}.${DOMAIN}`))
          .status === 200
      ) {
        up = true;
        break;
      }
      await Bun.sleep(50);
    }
    expect(up).toBe(true);

    // Close it while the test step is still sleeping.
    const closed = await mergePull(
      app,
      alice,
      repo,
      getPull(app.db, repo.id, opened.value.number)!,
      "merge",
    );
    expect(closed.ok).toBe(true);

    // Wait well past the sleep the test step was doing, and confirm it
    // never finished: the preview's own marker is not there (production's,
    // from its own unrelated redeploy of the same merged commit, may be).
    await Bun.sleep(6_500);
    expect(existsSync(`${marker}-preview`)).toBe(false);
  }, 60_000);
});
