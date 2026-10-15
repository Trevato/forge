/**
 * The side instance: a forge booted on its own data directory, with a few
 * fake runs, one open pull and one sealed value. Chaos only ever touches a
 * `World`; nothing here can name the live forge's data or a customer's app.
 */

import { join } from "node:path";
import { openPull } from "../actions/pulls.ts";
import { commitToBranch, createRepo } from "../actions/repos.ts";
import { createApp, type App } from "../app.ts";
import { claimRun, createRun } from "../core/runs.ts";
import { setSecret } from "../core/secret_store.ts";
import { createUser } from "../core/users.ts";

/** The value the sealed invariant hunts for; it never leaves the store. */
export const SEALED_VALUE = "chaos-sealed-value-do-not-print";

export interface World {
  readonly dataDir: string;
  app: App;
  readonly repoId: string;
  /** Every run id the world ever made: none may vanish. */
  readonly runIds: Set<string>;
}

export async function bootWorld(dataDir: string): Promise<World> {
  const app = createApp({ dataDir, port: 0 });
  const made = await createUser(app.db, {
    trusted: true,
    username: "chaos",
    email: "chaos@forge.local",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const repo = await createRepo(app, made.value, { name: "side" });
  if (!repo.ok) throw new Error(String(repo.error));
  const seeded = await commitToBranch(app, made.value, repo.value, {
    message: "Start",
    files: [{ path: "README.md", content: "# side\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  const branch = await commitToBranch(app, made.value, repo.value, {
    branch: "feature/x",
    base: "main",
    message: "x",
    files: [{ path: "x.ts", content: "export const x = 1;\n" }],
  });
  if (!branch.ok) throw new Error(JSON.stringify(branch.error));
  const pull = await openPull(app, made.value, repo.value, {
    title: "x",
    baseBranch: "main",
    headBranch: "feature/x",
  });
  if (!pull.ok) throw new Error(String(pull.error));
  setSecret(app.db, dataDir, "forge", "", "CHAOS_SECRET", SEALED_VALUE);

  const runIds = new Set<string>();
  for (const kind of ["check", "deploy", "check"] as const) {
    const run = createRun(app.db, { repoId: repo.value.id, kind });
    runIds.add(run.id);
  }
  const [first] = [...runIds];
  claimRun(app.db, first!);
  return { dataDir, app, repoId: repo.value.id, runIds };
}

/** Close and open again on the same directory: what a restart is. */
export function reopen(world: World): void {
  try {
    world.app.close();
  } catch {
    // Already closed by the fault.
  }
  world.app = createApp({ dataDir: world.dataDir, port: 0 });
}

export const dbFile = (world: World): string => join(world.dataDir, "forge.db");
