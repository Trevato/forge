/**
 * A green deploy says what its tests did (words.ts `testsClause`): the
 * pull's note reads "its tests passed" when the app's suite ran, and says
 * nothing was run when the app declares no test. Real deploys, so this file
 * owns its forge and data directory: `test/apps.test.ts` shares one forge
 * across its tests and counts previews, which these would leak into.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { newApp } from "../src/actions/apps.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import type { AppRecord } from "../src/core/apps.ts";
import { getPull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { pullWord, servingHistory } from "../src/web/studio/words.ts";

describe("a green deploy says what its tests did", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let repo: Repo;
  let record: AppRecord;

  async function settled(where: (run: Run) => boolean): Promise<Run> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const run = listRuns(app.db, repo.id, { kind: "deploy", limit: 50 }).find(
        where,
      );
      if (run && ["ok", "failed", "cancelled"].includes(run.state)) return run;
      await Bun.sleep(100);
    }
    throw new Error("run did not settle in time");
  }

  const word = (number: number) =>
    pullWord(
      {
        db: app.db,
        dir: repoDir(app.reposRoot, repo.ownerName, repo.name),
        runtime,
        record,
        history: servingHistory(),
        viewer: alice,
      },
      getPull(app.db, repo.id, number)!,
    );

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-apps-clause-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: "apps.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 2,
    });
    await runtime.start();
    const created = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;
    const made = await newApp(app, alice, {
      name: "clause",
      description: "Tests clause",
      visibility: "public",
    });
    if (!made.ok) throw new Error(made.error);
    repo = made.value.repo;
    record = made.value.app;
    await settled((r) => r.env === "production");
  }, 90_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the suite passed: the pull says its tests passed", async () => {
    const committed = await commitToBranch(app, alice, repo, {
      branch: "passing",
      base: repo.defaultBranch,
      message: "A passing test",
      files: [
        {
          path: "src/server.test.ts",
          content:
            'import { expect, test } from "bun:test";\ntest("passes", () => { expect(1).toBe(1); });\n',
        },
      ],
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const opened = await openPull(app, alice, repo, {
      title: "Passing",
      baseBranch: repo.defaultBranch,
      headBranch: "passing",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const green = await settled(
      (r) =>
        r.env === `pull-${opened.value.number}` &&
        r.commitOid === committed.value.commitOid,
    );
    expect(green.state).toBe("ok");
    expect((await word(opened.value.number)).note).toBe(
      "green — its tests passed, ready for a look",
    );
    const merged = await mergePull(app, alice, repo, opened.value, "merge");
    expect(merged.ok).toBe(true);
  }, 120_000);

  test("an app that declares no test: the pull says nothing was run", async () => {
    const committed = await commitToBranch(app, alice, repo, {
      branch: "untested",
      base: repo.defaultBranch,
      message: "No tests declared",
      files: [
        {
          path: "forge.json",
          content: `${JSON.stringify(
            { app: { run: "bun run src/server.ts", tty: "bun run src/tty.ts" } },
            null,
            2,
          )}\n`,
        },
      ],
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const opened = await openPull(app, alice, repo, {
      title: "Untested",
      baseBranch: repo.defaultBranch,
      headBranch: "untested",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const green = await settled(
      (r) =>
        r.env === `pull-${opened.value.number}` &&
        r.commitOid === committed.value.commitOid,
    );
    expect(green.state).toBe("ok");
    expect(await word(opened.value.number)).toEqual({
      word: "look",
      note: "green — it answered, no tests were run, ready for a look",
    });
  }, 120_000);
});
