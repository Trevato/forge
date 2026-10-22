/**
 * `require_checks`, the red half (docs/APPS.md): a pull whose head's tests
 * fail has a settled `failed` deploy, the merge is refused, and the preview
 * still answers with its own page. Waits on the deploy of that exact head
 * (`commitOid`), never on "the latest". The green half is its own file.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newApp } from "../src/actions/apps.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, updateRepoSettings } from "../src/actions/repos.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepoById } from "../src/core/repos.ts";
import {
  APPS_DOMAIN,
  deploySettled,
  fetchAsHost,
  startAppsForge,
  stopAppsForge,
  type AppsForge,
} from "./helpers/apps-forge.ts";

describe("require_checks: a failing head", () => {
  let forge: AppsForge;

  beforeAll(async () => {
    forge = await startAppsForge();
  }, 60_000);

  afterAll(async () => {
    await forge.runtime.stop();
    await stopAppsForge(forge);
  });

  test("refuses the merge and its preview still answers", async () => {
    const { app, alice, servers, runtime } = forge;
    const made = await newApp(app, alice, {
      name: "hello",
      description: "A place for notes",
      visibility: "public",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const record = made.value.app;
    let repo = made.value.repo;
    const production = await deploySettled(
      app,
      repo.id,
      (r) => r.env === "production",
    );
    expect(production.state).toBe("ok");

    expect(
      (await updateRepoSettings(app, alice, repo, { requireChecks: true })).ok,
    ).toBe(true);
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
    if (!broken.ok) return;
    const opened = await openPull(app, alice, repo, {
      title: "Broken",
      baseBranch: repo.defaultBranch,
      headBranch: "broken",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const number = opened.value.number;

    const failed = await deploySettled(
      app,
      repo.id,
      (r) =>
        r.env === `pull-${number}` && r.commitOid === broken.value.commitOid,
    );
    expect(failed.state).toBe("failed");
    expect(failed.summary).toContain("test");

    const refused = await mergePull(
      app,
      alice,
      repo,
      getPull(app.db, repo.id, number)!,
      "merge",
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("checks_required");

    // The app never broke, only its tests: the preview answers with its own
    // page rather than a gateway error.
    const page = await fetchAsHost(servers, `hello--${number}.${APPS_DOMAIN}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`preview of pull #${number}`);
    const status = runtime.envStatus(record, `pull-${number}`);
    expect(status?.state).toBe("running");
    expect(status?.error).toContain("tests failed");
  }, 120_000);
});
