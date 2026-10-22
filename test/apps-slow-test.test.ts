/**
 * Apps: a deploy whose test step sleeps answers before its tests finish.
 * Starts from `hello` serving in production (`helpers/apps-forge.ts`);
 * split from `apps.test.ts` so each part runs apart (#1798).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import type { AppRecord } from "../src/core/apps.ts";
import { listEvents } from "../src/core/events.ts";
import { getPull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import type { User } from "../src/core/users.ts";
import type { Servers } from "../src/http/server.ts";

import {
  APPS_DOMAIN,
  deploySettled,
  fetchAsHost,
  startAppsForge,
  startHello,
  stopAppsForge,
  type AppsForge,
} from "./helpers/apps-forge.ts";

describe("apps: a slow test step", () => {
  let forge: AppsForge;
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

  beforeAll(async () => {
    forge = await startAppsForge();
    ({ app, servers, runtime, alice } = forge);
    ({ repo, record } = await startHello(forge));
  }, 60_000);

  afterAll(async () => {
    await runtime.stop();
    await stopAppsForge(forge);
  });

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
});
