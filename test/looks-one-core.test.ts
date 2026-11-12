/**
 * One core (#11598): on a 1-CPU forge a look waits while a crew run is
 * working and is taken on the first sweep after it ends; with a second
 * core it is taken at once. The CPU count and the run count are injected.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import type { AppRecord } from "../src/core/apps.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { ok } from "../src/kernel/result.ts";
import type { Capture, LookInput } from "../src/looks/capture.ts";
import { startLooks } from "../src/looks/service.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

describe("looks on one core", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let record: AppRecord;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-looks-core-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const runtime = new AppsRuntime(app, {
      domain: "apps.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 2,
    });
    await runtime.start();
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const made = await newApp(app, a.value, { name: "hello", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    record = made.value.app;
    const until = Date.now() + 30_000;
    while (runtime.envStatus(record, "production")?.state !== "running") {
      if (Date.now() > until) throw new Error("production never ran");
      await Bun.sleep(25);
    }
  });

  afterAll(async () => {
    await servers.stop?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  const trial = (cpus: number) => {
    app.db.query("DELETE FROM look WHERE app_id = ?").run(record.id);
    const seen: LookInput[] = [];
    const capture: Capture = async (input) => {
      seen.push(input);
      writeFileSync(input.out, PNG);
      return ok({ entries: {} });
    };
    let active = 1;
    const looks = startLooks(app, {
      localUrl: servers.url,
      capture,
      cpus: () => cpus,
      activeCrewRuns: () => active,
      answers: async () => true,
      answerWaitMs: 1_000,
      answerPollMs: 5,
    });
    return { looks, seen, end: () => (active = 0) };
  };

  test("1 CPU with a crew run working takes no look; once the run is gone the next sweep takes it", async () => {
    const { looks, seen, end } = trial(1);
    looks.sweep();
    await looks.idle();
    looks.sweep();
    await looks.idle();
    expect(seen).toHaveLength(0);
    end();
    looks.sweep();
    await looks.idle();
    expect(seen.length).toBeGreaterThan(0);
    await looks.stop();
  });

  test("2 CPUs with a crew run working takes the look at once", async () => {
    const { looks, seen } = trial(2);
    looks.sweep();
    await looks.idle();
    expect(seen.length).toBeGreaterThan(0);
    await looks.stop();
  });
});
