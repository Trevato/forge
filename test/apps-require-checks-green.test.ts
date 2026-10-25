/**
 * `require_checks`, the green half (#5278): after a fixing push the merge
 * waits for the deploy of the *new* head — not the old red one — and then
 * goes. The test holds that deploy at the runtime's gate until it has seen
 * the merge refused, so no deploy can finish between the push and the
 * attempt; every wait is on the deploy record for the exact commit.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, updateRepoSettings } from "../src/actions/repos.ts";
import type { AppRecord } from "../src/core/apps.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import {
  deploySettled,
  startAppsForge,
  fetchAsHost,
  APPS_DOMAIN,
  startHello,
  stopAppsForge,
  type AppsForge,
} from "./helpers/apps-forge.ts";

const suite = (passes: boolean): string =>
  `import { expect, test } from "bun:test";\ntest("t", () => { expect(1).toBe(${passes ? 1 : 2}); });\n`;

describe("require_checks: the fixed head's deploy", () => {
  let forge: AppsForge;
  let repo: Repo;
  let record: AppRecord;

  beforeAll(async () => {
    forge = await startAppsForge();
    ({ repo, record } = await startHello(forge));
  }, 90_000);

  afterAll(async () => {
    await forge.runtime.stop();
    await stopAppsForge(forge);
  });

  /** The deploy record of exactly this commit, in whatever state it is in. */
  const deployOf = async (commitOid: string): Promise<Run> => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const run = listRuns(forge.app.db, repo.id, {
        kind: "deploy",
        limit: 50,
      }).find((r) => r.commitOid === commitOid);
      if (run) return run;
      await Bun.sleep(20);
    }
    throw new Error(`no deploy recorded for ${commitOid}`);
  };

  test("the merge is held until the fixed head's deploy is green, then goes", async () => {
    const { app, alice, runtime } = forge;
    expect(
      (await updateRepoSettings(app, alice, repo, { requireChecks: true })).ok,
    ).toBe(true);
    repo = getRepoById(app.db, repo.id)!;

    const broken = await commitToBranch(app, alice, repo, {
      branch: "broken",
      base: repo.defaultBranch,
      message: "Break the test",
      files: [{ path: "src/server.test.ts", content: suite(false) }],
    });
    expect(broken.ok).toBe(true);
    if (!broken.ok) return;
    const opened = await openPull(app, alice, repo, {
      title: "Broken",
      baseBranch: repo.defaultBranch,
      headBranch: "broken",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const number = opened.value.number;
    const red = await deploySettled(
      app,
      repo.id,
      (r) => r.commitOid === broken.value.commitOid,
    );
    expect(red.state).toBe("failed");
    expect(red.summary).toContain("test");
    const refused = await mergePull(app, alice, repo, opened.value, "merge");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("checks_required");
    // The app never broke, only its tests: the preview answers with its own
    // page, because a deployment that answers is what was asked for.
    const page = await fetchAsHost(
      forge.servers,
      `hello--${number}.${APPS_DOMAIN}`,
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`preview of pull #${number}`);
    const status = runtime.envStatus(record, `pull-${number}`);
    expect(status?.state).toBe("running");
    expect(status?.error).toContain("tests failed");

    // Hold every permit: the fixing head's deploy is recorded but cannot run.
    const releases: (() => void)[] = [];
    for (let i = 0; i < runtime.lane.limit; i++)
      releases.push(await runtime.lane.acquire());
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const r of releases) r();
    };
    try {
      const fixed = await commitToBranch(app, alice, repo, {
        branch: "broken",
        message: "Fix the test",
        files: [{ path: "src/server.test.ts", content: suite(true) }],
      });
      expect(fixed.ok).toBe(true);
      if (!fixed.ok) return;
      expect(fixed.value.commitOid).not.toBe(broken.value.commitOid);

      const pending = await deployOf(fixed.value.commitOid);
      expect(pending.env).toBe(`pull-${number}`);
      expect(["queued", "running"]).toContain(pending.state);
      const held = await mergePull(
        app,
        alice,
        repo,
        getPull(app.db, repo.id, number)!,
        "merge",
      );
      expect(held.ok).toBe(false);
      if (!held.ok) expect(held.error).toBe("checks_required");

      release();
      const green = await deploySettled(
        app,
        repo.id,
        (r) => r.commitOid === fixed.value.commitOid,
      );
      expect(green.state).toBe("ok");
      const merged = await mergePull(
        app,
        alice,
        repo,
        getPull(app.db, repo.id, number)!,
        "merge",
      );
      expect(merged.ok).toBe(true);
    } finally {
      release();
    }
  }, 120_000);
});
