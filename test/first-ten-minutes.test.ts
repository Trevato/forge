/** A forge answers everything in its first ten minutes (#11155). */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { childDirOf } from "../src/actions/spawn.ts";
import { recordBoot, recordCleanExit, uncleanInFirstMinutes } from "../src/kernel/boots.ts";
import { proveBoots } from "../src/spawn/reach.ts";
import { answers, cellChildren, firstAnswer, isNewForge, makeRegistry, NEW_FORGE_MS, START_PROBES, type CellChild } from "../src/spawn/cell.ts";
import { answerFromCell, waitingFor, wakeLimits } from "../src/spawn/host.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
const tmp = mkdtempSync(join(tmpdir(), "first-ten-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("the boots proof", () => {
  test("a clean first ten minutes is ok, an unclean restart in them is not, and it alarms through reach", () => {
    const dir = join(tmp, "b");
    mkdirSync(dir);
    expect(uncleanInFirstMinutes(dir)).toBeNull();
    recordBoot(dir, "a", 1_000);
    recordCleanExit(dir, "a");
    recordBoot(dir, "b", 2_000);
    expect(uncleanInFirstMinutes(dir, undefined, 4_000)).toBe(0);
    recordBoot(dir, "c", 3_000); // "b" never said goodbye
    expect(uncleanInFirstMinutes(dir, undefined, 4_000)).toBe(1);
    recordBoot(dir, "d", 20 * 60_000); // an unclean start long after the first ten minutes
    expect(uncleanInFirstMinutes(dir, undefined, 20 * 60_000)).toBe(2); // b and c; d is the running one
  });

  test("an early unclean start stops counting after the memory, so the alarm clears", () => {
    const dir = join(tmp, "m");
    mkdirSync(dir);
    recordBoot(dir, "a", 1_000);
    recordBoot(dir, "b", 2_000);
    expect(uncleanInFirstMinutes(dir, undefined, 3_000)).toBe(1);
    expect(uncleanInFirstMinutes(dir, undefined, 2 * 3_600_000)).toBe(0);
  });

  test("the window is anchored on the first start, even after the ledger trims its oldest", () => {
    const dir = join(tmp, "trim");
    mkdirSync(dir);
    const min = 60_000;
    recordBoot(dir, "first", 0);
    recordCleanExit(dir, "first");
    for (let i = 0; i < 50; i++) {
      recordBoot(dir, `later-${i}`, 30 * min + i);
      recordCleanExit(dir, `later-${i}`);
    }
    recordBoot(dir, "crashed", 31 * min); // unclean, but twenty minutes past the first start
    recordBoot(dir, "now", 32 * min);
    expect(uncleanInFirstMinutes(dir, undefined, 32 * min)).toBe(0);
  });

  test("proveBoots reads the child's own ledger", () => {
    const parent = createApp({ dataDir: join(tmp, "p"), url: "https://f.test" });
    const child = { url: "https://kid--f.test", bodyId: "body-1" };
    expect(proveBoots(parent, child)).toBeUndefined();
    mkdirSync(childDirOf(parent, "body-1"), { recursive: true });
    const t = Date.now();
    recordBoot(childDirOf(parent, "body-1"), "a", t - 2_000);
    recordBoot(childDirOf(parent, "body-1"), "b", t - 1_000);
    expect(proveBoots(parent, child)).toMatchObject({ label: "boots", ok: false, says: "1 unclean restart in the first ten minutes" });
    parent.close();
  });
});

describe("a new forge is not slept, and a start gets its minute", () => {
  test("isNewForge: under ten minutes stays, older sleeps, unknown start sleeps", () => {
    expect(isNewForge(1_000, 1_000 + NEW_FORGE_MS - 1)).toBe(true);
    expect(isNewForge(1_000, 1_000 + NEW_FORGE_MS)).toBe(false);
    expect(isNewForge(undefined, 5)).toBe(false);
  });

  test("a start gets about a minute: 600 probes, 100 ms apart", () => {
    expect(START_PROBES).toBe(600);
  });

  test("answers finds a port that begins listening late, and stops when the child is gone or probes run out", async () => {
    const free = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const port = free.port!;
    free.stop(true);
    const found = answers(port, new Promise(() => {}), 300);
    // Bind once the first probe has had its chance to fail; tried again until the port is ours.
    let late: ReturnType<typeof Bun.serve> | undefined;
    await Bun.sleep(100);
    while (late === undefined) {
      try {
        late = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("up") });
      } catch {
        await Bun.sleep(50);
      }
    }
    expect(await found).toBe(true);
    late.stop(true);
    expect(await answers(port, new Promise(() => {}), 2)).toBe(false);
    expect(await answers(port, Promise.resolve(), 600)).toBe(false);
  });
});

/** A process that says "ready" once it listens for SIGTERM, and exits 7 on it: 7 is a gentle stop, a SIGKILL has no code. */
async function gentleProcess() {
  const proc = Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => process.exit(7)); console.log('ready'); setInterval(() => {}, 1000)"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const reader = proc.stdout.getReader();
  let said = "";
  while (!said.includes("ready")) {
    const { value, done } = await reader.read();
    if (done) break;
    said += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return proc;
}

describe("the idle sweep and a failed start", () => {
  test("sleepIdle leaves a just-started forge alone past the idle time, and sleeps it after its first ten minutes", async () => {
    const parent = createApp({ dataDir: join(tmp, "sweep"), url: "https://f.test" });
    const proc = await gentleProcess();
    const cells = makeRegistry(parent, async (input) => ({ ...input, port: 1, limits: {} as CellChild["limits"], pid: proc.pid, exited: proc.exited }));
    try {
      const idle = 60_000;
      const start = Date.now();
      expect(await cells.start({ bodyId: "kid-1", name: "kid", size: "small" })).toBeDefined();
      expect(await cells.sleepIdle(idle, start + idle * 2)).toEqual([]);
      expect(cells.get("kid-1")).toBeDefined();
      expect(await cells.sleepIdle(idle, Date.now() + NEW_FORGE_MS + idle)).toEqual(["kid"]);
      expect(cells.get("kid-1")).toBeUndefined();
      expect(await proc.exited).toBe(7);
    } finally {
      proc.kill("SIGKILL");
      parent.close();
    }
  });

  test("a start that never answers is asked to go with SIGTERM first, not killed", async () => {
    const free = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const port = free.port!;
    free.stop(true);
    const proc = await gentleProcess();
    let told = 0;
    try {
      expect(await firstAnswer({ pid: proc.pid, exited: proc.exited }, port, () => told++, 2)).toBe(false);
      expect(told).toBe(1);
      expect(await proc.exited).toBe(7);
      expect(proc.signalCode).toBeNull();
    } finally {
      proc.kill("SIGKILL");
    }
  });
});

/** A start the test lets finish when it says so. */
function gate<T>() {
  let open!: (v: T) => void;
  const shut = new Promise<T>((r) => (open = r));
  return { shut, open };
}

describe("a request while a cell wakes", () => {
  test("a POST is held until the cell is up and gets its answer, not a 503", async () => {
    const dataDir = join(tmp, "w");
    mkdirSync(join(dataDir, "spawn"), { recursive: true });
    writeFileSync(join(dataDir, "spawn", "kid.json"), JSON.stringify({ name: "kid", bodyId: "cell-w", size: "small", done: true, placement: "cell" }));
    const parent = createApp({ dataDir, url: "https://f.test" });
    const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (r) => new Response(`got ${r.method} ${await r.text()}`) });
    const cells = cellChildren(parent);
    cells.start = async () => {
      await Bun.sleep(300); // a POST is held while the cell wakes, however long a page's old patience was
      return { port: upstream.port } as unknown as CellChild;
    };
    try {
      const res = await answerFromCell(parent, new Request("https://kid--f.test/create", { method: "POST", body: "name=x", headers: { host: "kid--f.test", accept: "text/html" } }));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("got POST name=x");
    } finally {
      upstream.stop(true);
      parent.close();
    }
  });

  const asleep = (dir: string, body: string) => {
    mkdirSync(join(dir, "spawn"), { recursive: true });
    writeFileSync(join(dir, "spawn", "kid.json"), JSON.stringify({ name: "kid", bodyId: body, size: "small", done: true, placement: "cell" }));
    return createApp({ dataDir: dir, url: "https://f.test" });
  };
  const post = () => new Request("https://kid--f.test/create", { method: "POST", body: "n=1", headers: { host: "kid--f.test", accept: "text/html" } });

  test("a wake longer than the wait gets the waking page, and the wait is the limit", async () => {
    const parent = asleep(join(tmp, "slow"), "cell-slow");
    const was = wakeLimits.waitMs;
    wakeLimits.waitMs = 100;
    const wake = gate<CellChild | undefined>();
    let woken = false;
    cellChildren(parent).start = () => wake.shut.then((c) => ((woken = true), c));
    try {
      const res = await answerFromCell(parent, post());
      expect(woken).toBe(false); // answered while the wake is still under way
      expect(res.status).toBe(503);
      expect(await res.text()).toContain("waking");
    } finally {
      wake.open(undefined);
      wakeLimits.waitMs = was;
      parent.close();
    }
  });

  test("past the waiter cap a request is answered at once with the waking page; the held ones still get their answer", async () => {
    const parent = asleep(join(tmp, "cap"), "cell-cap");
    const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    const was = { ...wakeLimits };
    wakeLimits.waiters = 2;
    const wake = gate<CellChild>();
    cellChildren(parent).start = () => wake.shut;
    try {
      const settled: string[] = [];
      const held = [answerFromCell(parent, post()), answerFromCell(parent, post())].map((p) => p.then((r) => (settled.push("held"), r)));
      while (waitingFor("cell-cap") < 2) await Bun.sleep(5);
      const over = await answerFromCell(parent, post());
      settled.push("over");
      expect(over.status).toBe(503);
      wake.open({ port: upstream.port } as unknown as CellChild);
      for (const r of await Promise.all(held)) expect(r.status).toBe(200);
      expect(settled).toEqual(["over", "held", "held"]); // the one past the cap is answered before the held ones
      expect(waitingFor("cell-cap")).toBe(0);
      // The cap frees as waiters leave.
      expect((await answerFromCell(parent, post())).status).toBe(200);
    } finally {
      Object.assign(wakeLimits, was);
      upstream.stop(true);
      parent.close();
    }
  });
});
