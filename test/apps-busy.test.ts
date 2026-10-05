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
 * The app under test: `/work?s=N` starts a child that works for N seconds
 * and answers at once; `/stream` is an event stream that stays open until
 * the browser goes away.
 */
const BUSY_SERVER = `const port = Number(process.env.PORT ?? "0");
export const server = Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/work") {
      Bun.spawn(["sleep", String(Number(url.searchParams.get("s") ?? "1"))], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      return new Response("working");
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
  const WINDOW = 700;
  const GRACE = 4_000;

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
      await Bun.sleep(50);
    }
    throw new Error("did not happen in time");
  }
  const settled = (where: (run: Run) => boolean) =>
    until(() =>
      listRuns(app.db, repo.id, { kind: "deploy", limit: 50 }).find(
        (r) => where(r) && (r.state === "ok" || r.state === "failed"),
      ),
    );
  const asleep = () =>
    until(() => (production().state === "asleep" ? true : undefined), 20_000);
  const log = (): string =>
    readRunLog(dataDir, production().runId!, 64 * 1024).lines.join("\n");

  /** Wake production and wait for it to fall asleep, so each test starts rested. */
  async function freshlyAwake(): Promise<void> {
    if (production().state !== "asleep") await asleep();
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
      // Long enough for the scaffold and the busy app to deploy and settle.
      sleepAfterMs: { production: 3_600_000, preview: 3_600_000 },
      sweepEveryMs: 100,
      busyGraceMs: GRACE,
    });
    await runtime.start();
    const created = await createUser(app.db, { trusted: true,
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
      ],
    });
    if (!committed.ok) throw new Error(String(committed.error));
    const run = await settled(
      (r) =>
        r.env === "production" && r.commitOid === committed.value.commitOid,
    );
    if (run.state !== "ok") throw new Error(`deploy failed: ${run.summary}`);
    // The runtime the rest of the suite judges: the same data, a short window.
    await runtime.stop();
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      sleepAfterMs: { production: WINDOW, preview: WINDOW },
      sweepEveryMs: 100,
      busyGraceMs: GRACE,
    });
    await runtime.start();
    await until(() => (production().state === "running" ? true : undefined));
  }, 180_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an idle app still sleeps, and says nothing about being busy", async () => {
    await freshlyAwake();
    await asleep();
    expect(production().busy).toBeUndefined();
    expect(log()).toContain("asleep: nothing asked for it");
  }, 30_000);

  test.skipIf(noProc)(
    "an app whose child is still working survives the sweep, then sleeps once it is done",
    async () => {
      await freshlyAwake();
      // Five seconds of work: long enough that a loaded machine still checks
      // while the child is busy (two seconds raced the check under load).
      expect(await (await viaHost("/work?s=5")).text()).toBe("working");
      // Well past the idle window, and still up: it was asked, and it is busy.
      await Bun.sleep(WINDOW + 700);
      expect(production().state).toBe("running");
      expect(production().busy).toContain("child processes");
      expect(log()).toContain("kept awake: busy");

      // The app page and the Now card both say why it is up.
      const page = await (await fetch(`${servers.url}/alice/busy/app`)).text();
      expect(page).toContain("busy — its child processes are still working");
      const now = await (
        await fetch(`${servers.url}/alice/busy/app/now`)
      ).text();
      expect(now).toContain(">busy<");
      expect(now).toContain("its child processes are still working");

      // The child finishes; the next sweep finds nothing to wait for.
      await asleep();
      expect(production().busy).toBeUndefined();
    },
    30_000,
  );

  test("an open stream keeps the app awake until it closes", async () => {
    await freshlyAwake();
    const abort = new AbortController();
    const response = await viaHost("/stream", { signal: abort.signal });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("data: hello");
    await Bun.sleep(WINDOW + 700);
    expect(production().state).toBe("running");
    expect(production().busy).toContain("a stream to it is still open");

    abort.abort();
    await reader.cancel().catch(() => {});
    await asleep();
  }, 30_000);

  test.skipIf(noProc)(
    "an app that stays busy sleeps anyway once the grace is spent",
    async () => {
      await freshlyAwake();
      const started = Date.now();
      // Works far longer than the window and the grace together.
      await viaHost("/work?s=12");
      await Bun.sleep(WINDOW + 700);
      expect(production().state).toBe("running");
      await asleep();
      expect(Date.now() - started).toBeGreaterThanOrEqual(WINDOW + GRACE);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(log()).toContain("asleep: still busy");
    },
    30_000,
  );
});
