/**
 * A forge with its apps runtime and one signed-in person, for the apps
 * suites that drive real deploys (docs/APPS.md). One forge per test file:
 * `apps*.test.ts` files that boot their own run apart and in parallel
 * (#1798).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../../src/app.ts";
import { newApp } from "../../src/actions/apps.ts";
import { AppsRuntime } from "../../src/apps/runtime.ts";
import type { AppRecord } from "../../src/core/apps.ts";
import type { Repo } from "../../src/core/repos.ts";
import { listRuns, type Run } from "../../src/core/runs.ts";
import { createUser, type User } from "../../src/core/users.ts";
import { serve, type Servers } from "../../src/http/server.ts";

export const APPS_DOMAIN = "apps.test";

export interface AppsForge {
  readonly dataDir: string;
  /** A scratch directory for clones the test makes. */
  readonly work: string;
  readonly app: App;
  readonly servers: Servers;
  readonly runtime: AppsRuntime;
  /** The first user, an admin. */
  readonly alice: User;
}

export async function startAppsForge(): Promise<AppsForge> {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-apps-"));
  const work = await mkdtemp(join(tmpdir(), "forge-apps-work-"));
  const app = createApp({ dataDir, port: 0 });
  const servers = await serve(app);
  // Every app the runtime boots is handed this key; the tests sign as
  // the forge would.
  const runtime = new AppsRuntime(app, {
    domain: APPS_DOMAIN,
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
  return { dataDir, work, app, servers, runtime, alice: created.value };
}

/**
 * Everything but the runtime, which a test may have stopped and replaced:
 * the caller stops the one it holds first.
 */
export async function stopAppsForge(forge: AppsForge): Promise<void> {
  forge.servers.stop();
  forge.app.close();
  await rm(forge.dataDir, { recursive: true, force: true });
  await rm(forge.work, { recursive: true, force: true });
}

/** A request to the forge as if addressed to `host`, redirects left unfollowed. */
export const fetchAsHost = (
  servers: Servers,
  host: string,
  path = "/",
  init: RequestInit = {},
) =>
  fetch(`${servers.url}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), host },
    redirect: "manual",
  });

/** Wait for the newest deploy on `repoId` matching `where` to finish, and return it. */
export async function deploySettled(
  app: App,
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
    await Bun.sleep(100);
  }
  throw new Error("run did not settle in time");
}

/**
 * `hello`, the new-app scaffold, public and serving in production — where
 * `apps.test.ts`'s first test leaves it, for the files that start from there.
 */
export async function startHello(
  forge: AppsForge,
): Promise<{ repo: Repo; record: AppRecord }> {
  const made = await newApp(forge.app, forge.alice, {
    name: "hello",
    description: "A place for notes",
    visibility: "public",
  });
  if (!made.ok) throw new Error(String(made.error));
  const { repo, app: record } = made.value;
  const run = await deploySettled(
    forge.app,
    repo.id,
    (r) => r.env === "production",
  );
  if (run.state !== "ok") throw new Error(`hello did not deploy: ${run.summary}`);
  return { repo, record };
}
