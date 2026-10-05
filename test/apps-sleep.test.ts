/**
 * An environment nobody asks for sleeps, and wakes for the next request;
 * the forge coming back starts production warm and leaves previews asleep.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime, type EnvState } from "../src/apps/runtime.ts";
import { newApp } from "../src/actions/apps.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import type { AppRecord } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { readRunLog } from "../src/runs/log.ts";

describe("apps that sleep", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let repo: Repo;
  let record: AppRecord;
  let preview = "";
  const DOMAIN = "apps.test";
  const SOON = { production: 700, preview: 700 };
  const LATER = { production: 3_600_000, preview: 3_600_000 };

  const viaHost = (host: string, path = "/") =>
    fetch(`${servers.url}${path}`, { headers: { host }, redirect: "manual" });

  const stateOf = (env: string): EnvState | undefined =>
    runtime.status(record).find((e) => e.env === env)?.state;

  async function until<T>(read: () => T | undefined, ms = 60_000): Promise<T> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = read();
      if (value !== undefined) return value;
      await Bun.sleep(100);
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
    dataDir = await mkdtemp(join(tmpdir(), "forge-sleep-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      sleepAfterMs: SOON,
      sweepEveryMs: 150,
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
      name: "hello",
      description: "A place for notes",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value.repo;
    record = made.value.app;
    const run = await settled((r) => r.env === "production");
    expect(run.state).toBe("ok");
    expect((await viaHost(`hello.${DOMAIN}`)).status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an environment nobody asks for sleeps, and the next request wakes it", async () => {
    await until(() => (stateOf("production") === "asleep" ? true : undefined));
    const asleep = runtime.status(record).find((e) => e.env === "production")!;
    expect(asleep.port).toBeUndefined();
    expect(asleep.since).toBeDefined();
    // The request waits for the wake and gets the page, not a closed door.
    const page = await viaHost(`hello.${DOMAIN}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>hello</h1>");
    expect(stateOf("production")).toBe("running");
    const runId = runtime
      .status(record)
      .find((e) => e.env === "production")!.runId!;
    expect(log(runId)).toContain("asleep: nothing asked for it");
    expect(log(runId)).toContain("awake");
    // Wanted again, it stays up past the limit.
    await Bun.sleep(400);
    expect((await viaHost(`hello.${DOMAIN}`)).status).toBe(200);
    await Bun.sleep(400);
    expect(stateOf("production")).toBe("running");
  }, 30_000);

  test("the forge coming back starts production warm and leaves previews asleep", async () => {
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/greeting",
      base: "main",
      message: "Greet",
      files: [{ path: "GREETING.md", content: "hello there\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Greet",
      baseBranch: "main",
      headBranch: "feature/greeting",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    preview = `pull-${opened.value.number}`;
    const first = await settled((r) => r.env === preview);
    expect(first.state).toBe("ok");
    expect(log(first.id)).toContain("checking out");
    const before = listRuns(app.db, repo.id, { kind: "deploy", limit: 50 });

    // The forge goes down and comes back over the same data.
    await runtime.stop();
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      sleepAfterMs: LATER,
      sweepEveryMs: 150,
    });
    await runtime.start();

    // Production is started again — warm, from the checkout it kept.
    const boot = await settled(
      (r) => r.env === "production" && !before.some((b) => b.id === r.id),
    );
    expect(boot.state).toBe("ok");
    expect(log(boot.id)).toContain("warm start");
    expect(log(boot.id)).not.toContain("checking out");
    expect((await viaHost(`hello.${DOMAIN}`)).status).toBe(200);

    // The preview is asleep and cost nothing: no run, no process — and it
    // still points at the deploy that built it.
    expect(stateOf(preview)).toBe("asleep");
    expect(runtime.status(record).find((e) => e.env === preview)?.runId).toBe(
      first.id,
    );
    const after = listRuns(app.db, repo.id, { kind: "deploy", limit: 50 });
    expect(after.filter((r) => r.env === preview).length).toBe(
      before.filter((r) => r.env === preview).length,
    );
    const woke = await viaHost(`hello--${opened.value.number}.${DOMAIN}`);
    expect(woke.status).toBe(200);
    expect(stateOf(preview)).toBe("running");
  }, 120_000);
});
