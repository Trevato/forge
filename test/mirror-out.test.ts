/**
 * Mirror out's stop function: it waits for a push already running and starts
 * none after it. A push is held open here, so the verdict is the code's, not
 * how long a real git push takes on the check machine.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { setMirrorTarget } from "../src/core/migrate_mirror.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { startMirrorOut } from "../src/origins/mirror-out.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("mirror out: stopping", () => {
  let dataDir: string;
  let app: App;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mirror-out-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.test",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(String(made.error));
    const created = await createRepo(app, made.value, { name: "gizmo", visibility: "private" });
    if (!created.ok) throw new Error(created.error);
    repo = getRepo(app.db, "alice", "gizmo")!;
    app.db.run("PRAGMA foreign_keys = OFF");
    setMirrorTarget(app.db, {
      repoId: repo.id,
      originId: "origin-none",
      fullName: "octo/gizmo",
      cloneUrl: "https://example.test/octo/gizmo.git",
      tips: {},
    });
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  const landed = () => app.bus.append({ kind: "pull.merged", repoId: repo.id });

  test("the stop promise waits for a running push, and no push starts after it", async () => {
    let pushes = 0;
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const stop = startMirrorOut(app, async () => {
      pushes++;
      await held;
    });

    landed();
    expect(pushes).toBe(1);

    let stopped = false;
    const stopping = stop().then(() => (stopped = true));
    await Bun.sleep(50);
    expect(stopped).toBe(false);

    landed();
    release();
    await stopping;
    expect(stopped).toBe(true);
    await Bun.sleep(20);
    expect(pushes).toBe(1);
  });
});
