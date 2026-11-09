/**
 * An environment past its idle window is asked whether it is busy before
 * it is put to sleep: a child process still working, or a stream still
 * open through the proxy, keeps it awake — for one grace past the window,
 * never forever — and the app page and the Now card say *busy* while that
 * is why it is up. An idle one still sleeps.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { newApp } from "../src/actions/apps.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import type { AppRecord } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { readRunLog } from "../src/runs/log.ts";

/**
 * The app under test: `/work` starts a child that works until `/done` ends
 * it; `/slow` answers only once `/answer` is asked (`/waiting` counts
 * those held); `/stream` is an event
 * stream that stays open until the browser goes away. Nothing in it waits
 * on the wall clock, so the suite never does either.
 */
const BUSY_SERVER = `const port = Number(process.env.PORT ?? "0");
const children = new Set<ReturnType<typeof Bun.spawn>>();
const waiting: Array<() => void> = [];
export const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/work") {
      const child = Bun.spawn(["sleep", "300"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      children.add(child);
      return new Response("working");
    }
    if (url.pathname === "/done") {
      for (const child of children) {
        child.kill();
        await child.exited;
      }
      children.clear();
      return new Response("done");
    }
    if (url.pathname === "/slow") {
      return new Promise((resolve) =>
        waiting.push(() => resolve(new Response("late"))),
      );
    }
    if (url.pathname === "/waiting") {
      return new Response(String(waiting.length));
    }
    if (url.pathname === "/answer") {
      for (const answer of waiting.splice(0)) answer();
      return new Response("answered");
    }
    if (url.pathname === "/stream") {
      let timer: ReturnType<typeof setInterval> | undefined;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: hello\\n\\n"));
          timer = setInterval(
            () => controller.enqueue(new TextEncoder().encode(": tick\\n\\n")),
            100,
          );
        },
        cancel() {
          clearInterval(timer);
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response("busy app", { status: url.pathname === "/" ? 200 : 404 });
  },
});
`;

const BUSY_TEST = `import { expect, test } from "bun:test";
process.env.PORT = "0";
const { server } = await import("./server.ts");
test("serves the page", async () => {
  const response = await fetch(\`http://\${server.hostname}:\${server.port}/\`);
  expect(response.status).toBe(200);
});
`;

const noProc = !existsSync("/proc/self/task");

describe("apps that are busy", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let repo: Repo;
  let record: AppRecord;
  const DOMAIN = "apps.test";
  const HOST = `busy.${DOMAIN}`;
  // Windows of the sweep's own clock, which the suite runs ahead by hand:
  // no real wait ever reaches them, so nothing sleeps unless a test says so.
  const WINDOW = 60 * 60_000;
  const GRACE = 10 * 60_000;
  /** How far the sweep's clock runs ahead of the wall's. */
  let ahead = 0;
  /** How many sweeps have read the clock. */
  let sweeps = 0;

  const viaHost = (path = "/", init: RequestInit = {}) =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: { host: HOST },
      redirect: "manual",
    });

  const production = (): EnvStatus =>
    runtime.status(record).find((e) => e.env === "production")!;

  async function until<T>(read: () => T | undefined, ms = 60_000): Promise<T> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = read();
      if (value !== undefined) return value;
      await Bun.sleep(5);
    }
    throw new Error("did not happen in time");
  }
  const settled = (where: (run: Run) => boolean) =>
    until(() =>
      listRuns(app.db, repo.id, { kind: "deploy", limit: 50 }).find(
        (r) => where(r) && (r.state === "ok" || r.state === "failed"),
      ),
    );
  /**
   * Run the sweep's clock to `ms` past the wall and wait for two sweeps to
   * read it: the first decides synchronously after its read, so by the
   * second every environment has been judged at that hour.
   */
  async function sweepAt(ms: number): Promise<void> {
    ahead = ms;
    const from = sweeps;
    await until(() => (sweeps >= from + 2 ? true : undefined), 10_000);
  }
  const asleep = () =>
    until(() => (production().state === "asleep" ? true : undefined), 10_000);
  const log = (): string =>
    readRunLog(dataDir, production().runId!, 64 * 1024).lines.join("\n");
  /** What the run log gained after `before`. */
  const since = (before: string): string => log().slice(before.length);

  /** Put production to sleep and wake it, so each test starts rested. */
  async function freshlyAwake(): Promise<void> {
    if (production().state !== "asleep") {
      await viaHost("/done");
      await viaHost("/answer");
      await sweepAt(WINDOW + GRACE + 60_000);
      await asleep();
    }
    ahead = 0;
    expect((await viaHost("/")).status).toBe(200);
    expect(production().state).toBe("running");
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-busy-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      sleepAfterMs: { production: WINDOW, preview: WINDOW },
      clock: () => {
        sweeps++;
        return Date.now() + ahead;
      },
      sweepEveryMs: 10,
      busyGraceMs: GRACE,
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
      name: "busy",
      description: "An app with work of its own",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value.repo;
    record = made.value.app;
    await settled((r) => r.env === "production");
    const committed = await commitToBranch(app, alice, repo, {
      message: "Work in children, and stream",
      files: [
        { path: "src/server.ts", content: BUSY_SERVER },
        { path: "src/server.test.ts", content: BUSY_TEST },
        // The scaffold's suites that boot its real server go with it.
        { path: "src/audit.test.ts", content: null },
        { path: "src/openapi.test.ts", content: null },
        { path: "src/security.test.ts", content: null },
        { path: "src/site.test.ts", content: null },
      ],
    });
    if (!committed.ok) throw new Error(String(committed.error));
    const run = await settled(
      (r) =>
        r.env === "production" && r.commitOid === committed.value.commitOid,
    );
    if (run.state !== "ok") throw new Error(`deploy failed: ${run.summary}`);
    await until(() => (production().state === "running" ? true : undefined));
  }, 180_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an idle app still sleeps, and says nothing about being busy", async () => {
    // Invariant: idle past its window, an app with no work sleeps, and no busy is said.
    await freshlyAwake();
    const before = log();
    await sweepAt(WINDOW - 60_000);
    expect(production().state).toBe("running");
    await sweepAt(WINDOW);
    await asleep();
    expect(production().busy).toBeUndefined();
    expect(since(before)).toContain("asleep: nothing asked for it");
  });

  test.skipIf(noProc)(
    "an app whose child is still working survives the sweep, then sleeps once it is done",
    async () => {
      // Invariant: a working child keeps it awake past the window, the pages say so, and it sleeps once the child is gone.
      await freshlyAwake();
      const before = log();
      expect(await (await viaHost("/work")).text()).toBe("working");
      // Well past the idle window, and still up: it was asked, and it is busy.
      await sweepAt(WINDOW + 60_000);
      expect(production().state).toBe("running");
      expect(production().busy).toContain("child processes");
      expect(since(before)).toContain("kept awake: busy");

      // The app page and the Now card both say why it is up.
      const page = await (await fetch(`${servers.url}/alice/busy/app`)).text();
      expect(page).toContain("busy — its child processes are still working");
      const now = await (
        await fetch(`${servers.url}/alice/busy/app/now`)
      ).text();
      expect(now).toContain(">busy<");
      expect(now).toContain("its child processes are still working");

      // The child finishes; the next sweep finds nothing to wait for.
      expect(await (await viaHost("/done")).text()).toBe("done");
      await sweepAt(WINDOW + 60_000);
      await asleep();
      expect(production().busy).toBeUndefined();
    },
  );

  test("a request still waiting on its answer keeps the app awake", async () => {
    // Invariant: a request in flight keeps it awake past the window; once answered it sleeps.
    await freshlyAwake();
    const response = viaHost("/slow");
    // The app holds it, so the proxy is holding it too.
    while ((await (await viaHost("/waiting")).text()) !== "1") await Bun.sleep(5);
    await sweepAt(WINDOW + 60_000);
    expect(production().state).toBe("running");
    expect(production().busy).toContain("a request is still waiting");
    await viaHost("/answer");
    expect(await (await response).text()).toBe("late");
    await sweepAt(WINDOW + 60_000);
    await asleep();
  });

  test("an open stream keeps the app awake until it closes", async () => {
    // Invariant: an open stream keeps it awake past the window; once closed it sleeps.
    await freshlyAwake();
    const abort = new AbortController();
    const response = await viaHost("/stream", { signal: abort.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("data: hello");
    await sweepAt(WINDOW + 60_000);
    expect(production().state).toBe("running");
    expect(production().busy).toContain("a stream to it is still open");

    abort.abort();
    await reader.cancel().catch(() => {});
    await asleep();
  });

  test.skipIf(noProc)(
    "an app that stays busy sleeps anyway once the grace is spent",
    async () => {
      // Invariant: busy spares an app for one grace past its window, never longer.
      await freshlyAwake();
      const before = log();
      await viaHost("/work");
      await sweepAt(WINDOW + GRACE - 60_000);
      expect(production().state).toBe("running");
      expect(production().busy).toContain("child processes");
      await sweepAt(WINDOW + GRACE);
      await asleep();
      expect(since(before)).toContain("asleep: still busy");
    },
  );
});
