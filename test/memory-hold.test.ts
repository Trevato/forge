import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { startChecks } from "../src/checks/service.ts";
import { createRun, getRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { pump } from "../src/crew/dispatch.ts";
import type { CrewOptions } from "../src/crew/runner.ts";
import { QUEUE_WAIT_MAX_MS, vitals } from "../src/kernel/vitals.ts";
import { heldRuns, HOLD_WORDS } from "../src/runs/held.ts";
import { readRunLog } from "../src/runs/log.ts";
import {
  childPressure,
  HOLD_SHARE,
  memoryHold,
  READING_MS,
} from "../src/runs/memory_hold.ts";
import { CGROUP_DIR_ENV, SIZE_ENV } from "../src/spawn/usage.ts";
import { checkJson, checksForge } from "./helpers/checks-forge.ts";

describe("memory is held, not hit: the rule", () => {
  test("nothing running: a start is always allowed, however full", () => {
    expect(memoryHold(0, () => 0.99)).toBeUndefined();
  });
  test("work running and memory near the limit: new work waits, with a sentence", () => {
    expect(memoryHold(1, () => HOLD_SHARE)).toContain("75%");
  });
  test("work running and memory below the share, or unknown: starts", () => {
    expect(memoryHold(2, () => 0.5)).toBeUndefined();
    expect(memoryHold(2, () => undefined)).toBeUndefined();
  });
  test("a forge that is no cell child reads no pressure", () => {
    expect(childPressure({})).toBeUndefined();
  });
  test("the cgroup is read once a second, not on every pump", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-cgroup-"));
    try {
      const env = { [SIZE_ENV]: "small", [CGROUP_DIR_ENV]: dir };
      writeFileSync(join(dir, "memory.max"), "1000\n");
      writeFileSync(join(dir, "memory.current"), "800\n");
      const at = 5_000_000_000_000;
      expect(childPressure(env, at)).toBe(0.8);
      writeFileSync(join(dir, "memory.current"), "100\n");
      expect(childPressure(env, at + READING_MS - 1)).toBe(0.8);
      expect(childPressure(env, at + READING_MS)).toBe(0.1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the dispatcher holds a queued run under pressure", () => {
  let dataDir: string;
  let app: App;
  let repoId = "";
  const roomy = () => ({ freeBytes: 100, totalBytes: 100 });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-memory-hold-"));
    app = createApp({ dataDir, port: 0, disk: roomy });
    const owner = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "holder",
      email: "holder@forge.local",
      password: "a-good-passphrase",
    });
    if (!owner.ok) throw new Error(String(owner.error));
    repoId = crypto.randomUUID();
    app.db
      .query("INSERT INTO repo (id, owner_id, name, visibility, created_at) VALUES (?1, ?2, 'mem', 'private', ?3)")
      .run(repoId, owner.value.id, new Date().toISOString());
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a queued run stays queued and held as memory, is named in vitals, and the pump says so once", () => {
    const fake = join(dataDir, "never-run");
    writeFileSync(fake, "#!/bin/sh\nexit 1\n");
    chmodSync(fake, 0o755);
    const options = {
      forgeUrl: "http://127.0.0.1:1",
      localUrl: "http://127.0.0.1:1",
      binary: fake,
      concurrency: 3,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
      pressure: () => 0.9,
    } satisfies Partial<CrewOptions> as unknown as CrewOptions;
    const queued = createRun(app.db, { repoId, kind: "agent" });
    const hourAgo = new Date(Date.now() - 2 * QUEUE_WAIT_MAX_MS).toISOString();
    app.db.query("UPDATE run SET created_at = ?1 WHERE id = ?2").run(hourAgo, queued.id);
    // One of this forge's own runs is going.
    const going = new Map<string, Promise<void>>([["going", new Promise<void>(() => {})]]);

    pump(app, options, going);
    pump(app, options, going);
    expect(getRun(app.db, queued.id)?.state).toBe("queued");
    expect(heldRuns(app.db).get(queued.id)).toBe("memory");
    const log = readRunLog(dataDir, queued.id).lines.join("\n");
    expect(log).toContain("this forge holds 90% of its memory");
    expect(log.split("this forge holds").length - 1).toBe(1);

    // Vitals counts it as held on purpose, not as waiting: all held is no stalled queue ...
    const now = Date.now() + 1_000;
    const card = () =>
      vitals({ db: app.db, signals: app.signals, dataDir, disk: roomy, now }).degraded.find(
        (d) => d.cause === "queue:agent",
      );
    expect(card()).toBeUndefined();
    // ... and with another run waiting beside it, the card names the hold.
    const other = createRun(app.db, { repoId, kind: "agent" });
    app.db.query("UPDATE run SET created_at = ?1 WHERE id = ?2").run(hourAgo, other.id);
    expect(card()?.sentence).toContain(`held on purpose: 1 by ${HOLD_WORDS.memory}.`);
  });
});

describe("the check queue holds a second check under pressure", () => {
  const f = checksForge("forge-memory-checks-");
  let share = 0.9;

  test("a second check stays queued with the log line while one is in flight, and starts once the pressure drops", async () => {
    await f.checks.stop();
    f.checks = startChecks(f.app, {
      forgeUrl: f.servers.url,
      concurrency: 2,
      tickMs: 20,
      pressure: () => share,
    });
    const first = await commitToBranch(f.app, f.alice, f.repo, {
      message: "Holds a slot",
      files: [{ path: "forge.json", content: checkJson(f.held("mem-first")) }],
    });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    await f.until(() => f.checksOf(first.value.commitOid)[0]?.state === "running", "first running");
    const second = await commitToBranch(f.app, f.alice, f.repo, {
      message: "Waits for memory",
      files: [{ path: "forge.json", content: checkJson("test -f OK.md") }],
    });
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    await f.until(() => f.checksOf(second.value.commitOid).length > 0, "second queued");
    const id = f.checksOf(second.value.commitOid)[0]!.id;
    await f.until(() => readRunLog(f.dataDir, id).lines.join("\n").includes("this forge holds 90%"), "the hold said");
    await Bun.sleep(100); // real-timer: a hold is a start that never comes; let several ticks pass
    expect(getRun(f.app.db, id)?.state).toBe("queued");
    share = 0.1;
    const done = await f.settled((r) => r.id === id);
    expect(done.state).toBe("ok");
    f.release("mem-first");
  });
});
