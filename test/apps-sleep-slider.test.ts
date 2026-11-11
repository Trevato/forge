/**
 * The sweep reads its idle windows from the profit slider's position on
 * every pass: moving the slider changes when production sleeps with no
 * restart, and `app.always_on` keeps production awake even at 0. The
 * sweep's clock runs ahead so a window of minutes takes milliseconds.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
import { setEconomics } from "../src/settings/economics.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { deploysScreen } from "../src/tui/screens/deploys.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";

describe("sleep windows follow the slider", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let repo: Repo;
  let record: AppRecord;
  const DOMAIN = "apps.test";
  const ELEVEN_MINUTES = 11 * 60_000;
  let ahead = 0;

  const viaHost = (host: string) =>
    fetch(`${servers.url}/`, { headers: { host }, redirect: "manual" });
  const production = (): EnvStatus | undefined =>
    runtime.status(record).find((e) => e.env === "production");
  const position = (n: number) => setEconomics(app.db, { position: n, marginPct: 0 }, alice.id);

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
  const log = (runId: string): string =>
    readRunLog(dataDir, runId, 64 * 1024).lines.join("\n");

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-sleep-slider-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      sweepEveryMs: 100,
      clock: () => Date.now() + ahead,
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
    const made = await newApp(app, alice, { name: "hello", description: "Notes", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value.repo;
    record = made.value.app;
    expect((await settled((r) => r.env === "production")).state).toBe("ok");
  }, 120_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("at 100 production idle past the 0-anchor window stays up; moved to 0, the next sweep puts it to sleep", async () => {
    position(100);
    ahead = ELEVEN_MINUTES;
    await Bun.sleep(600);
    expect(production()?.state).toBe("running");
    position(0);
    await until(() => (production()?.state === "asleep" ? true : undefined), 5_000);
    expect(log(production()!.runId!)).toContain(
      "asleep: nothing asked for it in 10 min (economy 0); the next request wakes it",
    );
  }, 30_000);

  test("always_on wins over 0, and the status says so", async () => {
    ahead = 0;
    expect((await viaHost(`hello.${DOMAIN}`)).status).toBe(200);
    const before = new Set(listRuns(app.db, repo.id, { kind: "deploy", limit: 50 }).map((r) => r.id));
    const pinned = await commitToBranch(app, alice, repo, {
      branch: "main",
      message: "Always on",
      files: [{
        path: "forge.json",
        content: JSON.stringify({ app: { run: "bun run src/server.ts", health: "/healthz", always_on: true } }),
      }],
    });
    if (!pinned.ok) throw new Error(JSON.stringify(pinned.error));
    const run = await settled((r) => r.env === "production" && !before.has(r.id));
    expect(run.state).toBe("ok");
    await until(() => (production()?.alwaysOn === true ? true : undefined), 10_000);
    position(0);
    ahead = ELEVEN_MINUTES;
    await Bun.sleep(600);
    expect(production()?.state).toBe("running");
    expect(production()?.alwaysOn).toBe(true);
    // The terminal's deploys screen says the same fact as the page.
    const tui = createForgeApp(
      app,
      { sshUsername: alice.username, remoteAddress: "127.0.0.1", user: alice },
      { terminal: headlessTerminal(160, 30), exitHooks: false },
    );
    tui.app.start();
    await settleApp(tui.app);
    tui.app.push(deploysScreen(tui.session, tui.app.ctx, repo));
    await settleApp(tui.app);
    const text = tui.app.screen.toText();
    tui.app.stop();
    expect(text).toContain("never sleeps (app.always_on)");
  }, 120_000);
});
