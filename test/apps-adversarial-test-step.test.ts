/**
 * Adversarial coverage for apps (docs/APPS.md), through a live apps
 * runtime: what a failing install and a closed pull's test step leave
 * behind. Split from apps-adversarial.test.ts so no one file sets the
 * gate's floor (#2038); each file of the split boots its own forge and
 * runtime. Here one app serves both tests, each through a pull of its own,
 * and every wait is on the forge's event bus — nothing polls or sleeps
 * (#3567).
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
import type { ForgeEvent } from "../src/core/events.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { checkInstallCache } from "../src/checks/install.ts";
import { readRunLog } from "../src/runs/log.ts";
import { fixtureLock, fixtureRegistry } from "./helpers/fixture-registry.ts";

const DOMAIN = "apps.test";

describe("apps adversarial: the install and test steps", () => {
  let dataDir: string;
  let work: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let repo: Repo;

  const viaHost = (host: string, path = "/", init: RequestInit = {}) =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), host },
      redirect: "manual",
    });

  /**
   * The first value `look` gives, asked now and again after every event
   * the forge appends — a run's progress and an app's serving are both
   * announced on the bus, so nothing here polls on a timer.
   */
  function when<T>(
    look: (event?: ForgeEvent) => T | undefined,
    what: string,
    timeoutMs = 20_000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const done = (value: T): void => {
        unsubscribe();
        clearTimeout(timer);
        resolve(value);
      };
      const unsubscribe = app.bus.subscribe((event) => {
        const value = look(event);
        if (value !== undefined) done(value);
      });
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`${what} did not happen in time`));
      }, timeoutMs);
      const now = look();
      if (now !== undefined) done(now);
    });
  }

  const settled = (where: (run: Run) => boolean): Promise<Run> =>
    when(
      () =>
        listRuns(app.db, repo.id, { kind: "deploy", limit: 50 }).find(
          (run) =>
            where(run) &&
            (run.state === "ok" ||
              run.state === "failed" ||
              run.state === "cancelled"),
        ),
      "the deploy settling",
    );

  /** The pull branch carrying this forge.json (and any `extra` files), opened against the default branch. */
  async function pullWith(
    branch: string,
    manifest: Record<string, string>,
    extra: readonly { path: string; content: string }[] = [],
  ): Promise<{ number: number; commitOid: string }> {
    const committed = await commitToBranch(app, alice, repo, {
      branch,
      base: repo.defaultBranch,
      message: branch,
      files: [
        {
          path: "forge.json",
          content: `${JSON.stringify({ app: manifest }, null, 2)}\n`,
        },
        ...extra,
      ],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const opened = await openPull(app, alice, repo, {
      title: branch,
      baseBranch: repo.defaultBranch,
      headBranch: branch,
    });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    return {
      number: opened.value.number,
      commitOid: committed.value.commitOid,
    };
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
    const made = await newApp(app, alice, {
      name: "steps",
      visibility: "public",
    });
    if (!made.ok) throw new Error(made.error);
    repo = made.value.repo;
    const production = await settled((r) => r.env === "production");
    if (production.state !== "ok")
      throw new Error(`production did not deploy: ${production.summary}`);
  }, 30_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("install failing fails before test or start ever run — nothing from a half-installed tree", async () => {
    const testMarker = join(work, "install-test-marker");
    const runMarker = join(work, "install-run-marker");
    const pull = await pullWith("bad-install", {
      install: "exit 1",
      run: `touch ${runMarker} && bun run src/server.ts`,
      test: `touch ${testMarker} && bun test`,
    });

    const failed = await settled(
      (r) => r.env === `pull-${pull.number}` && r.commitOid === pull.commitOid,
    );
    expect(failed.state).toBe("failed");
    expect(failed.summary).toContain("install");
    // Neither `test` nor `run` ever executed.
    expect(existsSync(testMarker)).toBe(false);
    expect(existsSync(runMarker)).toBe(false);
    expect((await viaHost(`steps--${pull.number}.${DOMAIN}`)).status).toBe(
      502,
    );
  }, 20_000);

  test("a preview's install reads its repository's shared cache (#7544)", async () => {
    // A registry package on loopback, with the lockfile bun writes against
    // it: one the fill trusts (`checks/fillable.ts`), and the forge's own
    // registry setting, as an operator's mirror would be.
    const reg = await fixtureRegistry(join(work, "registry"));
    const before = process.env["BUN_CONFIG_REGISTRY"];
    process.env["BUN_CONFIG_REGISTRY"] = reg.url;
    try {
      const { packageJson, lock } = await fixtureLock(join(work, "registry"), reg.url);
      const pull = await pullWith(
        "shared-cache",
        {
          install: `bun install --frozen-lockfile && echo "install cache: \${BUN_INSTALL_CACHE_DIR:-none}"`,
          run: "bun run src/server.ts",
        },
        [
          { path: "package.json", content: packageJson },
          { path: "bun.lock", content: lock },
        ],
      );
      const run = await settled(
        (r) => r.env === `pull-${pull.number}` && r.commitOid === pull.commitOid,
      );
      const log = readRunLog(dataDir, run.id).lines;
      expect(run.state).toBe("ok");
      expect(log).toContain(`install cache: ${checkInstallCache(dataDir, repo.id)}`);
    } finally {
      if (before === undefined) delete process.env["BUN_CONFIG_REGISTRY"];
      else process.env["BUN_CONFIG_REGISTRY"] = before;
      reg.stop();
    }
  }, 30_000);

  test("a preview with a file: dependency installs without the shared cache (#7541)", async () => {
    // The fill runs on the host: a path dependency would be read there, so
    // the fill refuses it and the install runs into the environment's home.
    const pull = await pullWith(
      "file-dep",
      {
        install: `bun install --frozen-lockfile && echo "install cache: \${BUN_INSTALL_CACHE_DIR:-none}"`,
        run: "bun run src/server.ts",
      },
      [
        { path: "dep/package.json", content: `{"name":"dep","version":"1.0.0"}\n` },
        {
          path: "package.json",
          content: `${JSON.stringify({ name: "steps", version: "0.1.0", private: true, dependencies: { dep: "file:./dep" } })}\n`,
        },
        {
          path: "bun.lock",
          content: `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "steps",
      "dependencies": {
        "dep": "file:./dep",
      },
    },
  },
  "packages": {
    "dep": ["dep@file:dep", {}],
  }
}
`,
        },
      ],
    );
    const run = await settled(
      (r) => r.env === `pull-${pull.number}` && r.commitOid === pull.commitOid,
    );
    const log = readRunLog(dataDir, run.id).lines;
    expect(run.state).toBe("ok");
    expect(log.some((line) => line.includes("cache not filled"))).toBe(true);
    expect(log).not.toContain(`install cache: ${checkInstallCache(dataDir, repo.id)}`);
  }, 20_000);

  test("closing a pull whose deploy already answered kills its still-running test step — no orphan `bun test`", async () => {
    // A merge lands this same forge.json on the default branch and
    // production redeploys it too; only the preview's test step sleeps, so
    // production's legitimate run of it finishes at once and can never be
    // mistaken for the preview's orphan. The sleep is far longer than this
    // test may take: the preview's run can only settle in time if the close
    // killed the step.
    const marker = join(work, "slowtest-marker");
    const serving = when(
      (event) =>
        event?.kind === "app.serving" &&
        event.repoId === repo.id &&
        event.payload.env !== "production"
          ? String(event.payload.env)
          : undefined,
      "the preview serving",
    );
    const pull = await pullWith("slow-test", {
      run: "bun run src/server.ts",
      test: `if [ "$FORGE_APP_ENV" = preview ]; then sleep 30 && touch ${marker}; fi`,
    });
    const env = `pull-${pull.number}`;
    expect(await serving).toBe(env);
    expect((await viaHost(`steps--${pull.number}.${DOMAIN}`)).status).toBe(
      200,
    );

    // The app answers while its test step is still sleeping.
    const preview = (): Run | undefined =>
      listRuns(app.db, repo.id, { kind: "deploy", limit: 50 }).find(
        (r) => r.env === env && r.commitOid === pull.commitOid,
      );
    expect(preview()?.state).toBe("running");

    // Close it while the test step is still sleeping.
    const closed = await mergePull(
      app,
      alice,
      repo,
      getPull(app.db, repo.id, pull.number)!,
      "merge",
    );
    expect(closed.ok).toBe(true);

    // The step's outcome is only reported once its process has exited, so
    // a run settled as cancelled is a step that is gone — the shell that
    // would have touched the marker with it.
    const ended = await settled(
      (r) => r.env === env && r.commitOid === pull.commitOid,
    );
    expect(ended.state).toBe("failed");
    expect(ended.summary).toBe("test: test cancelled");
    expect(existsSync(marker)).toBe(false);
  }, 20_000);
});
