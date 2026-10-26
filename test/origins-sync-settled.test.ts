import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createOrigin, getOriginById } from "../src/core/origins.ts";
import { syncOrigin, syncsSettled } from "../src/origins/sync.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { getUserByName } from "../src/core/users.ts";

/**
 * `syncsSettled` is what lets a suite end only when the syncs it started
 * have: it must wait for a held sync, survive one that rejects, and also wait
 * for one that starts while it waits.
 */

interface Gate {
  url: string;
  open(): void;
  stop(): void;
}

/** An origin API that answers nothing until it is opened. */
function gate(): Gate {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const server = Bun.serve({
    port: 0,
    async fetch() {
      await opened;
      return Response.json([]);
    },
  });
  return {
    url: `http://localhost:${server.port}`,
    open,
    stop: () => void server.stop(true),
  };
}

/** Pending after a few turns of the event loop? */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await Bun.sleep(30);
  return !done;
}

describe("syncsSettled", () => {
  let dir: string;
  let app: App;
  const gates: Gate[] = [];

  const originOn = (g: Gate, login: string) => {
    const alice = getUserByName(app.db, "alice")!;
    const made = createOrigin(app.db, app.config.dataDir, {
      userId: alice.id,
      kind: "forgejo",
      apiUrl: `${g.url}/api/v1`,
      webUrl: g.url,
      login,
      token: "tok-" + login,
    });
    if (!made.ok) throw new Error(made.error);
    return getOriginById(app.db, made.value.id)!;
  };
  const held = () => {
    const g = gate();
    gates.push(g);
    return g;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-settled-"));
    app = createApp({ dataDir: dir, port: 0 });
    await seedAdmin(app, {
      username: "alice",
      email: "alice@forge.test",
      password: "alice-login-secret",
    });
  });

  afterEach(async () => {
    for (const g of gates.splice(0)) {
      g.open();
      g.stop();
    }
    await syncsSettled();
    try {
      app.close();
    } catch {}
    await rm(dir, { recursive: true, force: true });
  });

  test("it stays pending while a sync is held, and resolves when it ends", async () => {
    const g = held();
    const run = syncOrigin(app, originOn(g, "one"));
    expect(await isPending(syncsSettled())).toBe(true);
    g.open();
    await run;
    await syncsSettled();
    expect(await isPending(syncsSettled())).toBe(false);
  });

  test("it resolves, not rejects, when the sync rejects", async () => {
    const g = held();
    const run = syncOrigin(app, originOn(g, "two"));
    const failed = run.then(
      () => false,
      () => true,
    );
    const settled = syncsSettled();
    app.close();
    g.open();
    expect(await failed).toBe(true);
    await settled;
  });

  test("it waits for a sync that starts while it waits", async () => {
    const first = held();
    const second = held();
    const a = syncOrigin(app, originOn(first, "three"));
    const settled = syncsSettled();
    const b = syncOrigin(app, originOn(second, "four"));
    first.open();
    await a;
    expect(await isPending(settled)).toBe(true);
    second.open();
    await b;
    await settled;
  });
});
