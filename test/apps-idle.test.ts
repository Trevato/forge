/**
 * A preview whose pull nobody has touched for days is stopped, not removed:
 * its page says it is asleep and why, asking for it deploys it again, and a
 * restart leaves it as it was.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { newApp } from "../src/actions/apps.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import type { AppRecord } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const DAY = 86_400_000;

describe("previews of idle pulls sleep", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let repo: Repo;
  let record: AppRecord;
  const DOMAIN = "apps.test";

  const options = () => ({
    domain: DOMAIN,
    scheme: "http" as const,
    publicPort: servers.port,
    forgeUrl: servers.url,
    sweepEveryMs: 150,
    idlePullMs: 3 * DAY,
  });
  const envOf = (n: number): EnvStatus | undefined =>
    runtime.status(record).find((e) => e.env === `pull-${n}`);

  async function until<T>(read: () => T | undefined, ms = 60_000): Promise<T> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = read();
      if (value !== undefined) return value;
      await Bun.sleep(100);
    }
    throw new Error("did not happen in time");
  }
  const running = (n: number) =>
    until(() => (envOf(n)?.state === "running" ? true : undefined));

  async function pull(name: string): Promise<number> {
    const branch = await commitToBranch(app, alice, repo, {
      branch: `feature/${name}`,
      base: "main",
      message: name,
      files: [{ path: `${name}.md`, content: `${name}\n` }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: name,
      baseBranch: "main",
      headBranch: `feature/${name}`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    await running(opened.value.number);
    return opened.value.number;
  }

  /** Make a pull look untouched for `ms`: its row, and the pushes that opened it. */
  function age(n: number, ms: number): void {
    const then = new Date(Date.now() - ms).toISOString();
    app.db
      .query(
        "UPDATE issue SET updated_at = ?1 WHERE repo_id = ?2 AND number = ?3",
      )
      .run(then, repo.id, n);
    app.db
      .query("UPDATE run SET created_at = ?1 WHERE repo_id = ?2 AND env = ?3")
      .run(then, repo.id, `pull-${n}`);
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-idle-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, options());
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
      name: "hello",
      description: "A place for notes",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value.repo;
    record = made.value.app;
  }, 120_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a pull touched an hour ago keeps its preview; one idle past the age loses its process, and its page says so", async () => {
    const fresh = await pull("fresh");
    const idle = await pull("idle");
    age(fresh, 3_600_000);
    age(idle, 4 * DAY);
    await until(() => (envOf(idle)?.dormant !== undefined ? true : undefined));
    const asleep = envOf(idle)!;
    // Stopped is not failed: no error, no port, the commit and run kept.
    expect(asleep.state).toBe("stopped");
    expect(asleep.error).toBeUndefined();
    expect(asleep.port).toBeUndefined();
    expect(asleep.commitOid).not.toBe("");
    expect(asleep.runId).toBeDefined();
    await Bun.sleep(500);
    expect(envOf(fresh)?.state).toBe("running");
    expect(envOf(fresh)?.dormant).toBeUndefined();
    // Production is never put to sleep by a pull's age. It is waited for:
    // it deploys first and alone under the deploy gate, so on a slow
    // machine it is the one still coming up when the previews are already
    // running. When it is not running, its own words are the failure.
    const production = () =>
      runtime.status(record).find((e) => e.env === "production");
    await until(() =>
      production()?.state === "deploying" ? undefined : true,
    );
    expect(`${production()?.state}: ${production()?.error ?? ""}`).toBe(
      "running: ",
    );

    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({
        username: "alice",
        password: "a-good-passphrase",
      }),
      redirect: "manual",
    });
    const cookie = `${(signin.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=dev`;
    const page = await (
      await fetch(`${servers.url}/alice/hello/pulls/${idle}`, {
        headers: { cookie },
      })
    ).text();
    expect(page).toContain("Asleep");
    expect(page).toContain("nobody pushed or commented since");
    expect(page).toContain("Wake it");
    // A reader is told it sleeps, and handed no button.
    const reader = await (
      await fetch(`${servers.url}/alice/hello/pulls/${idle}`)
    ).text();
    expect(reader).toContain("nobody pushed or commented since");
    expect(reader).not.toContain("Wake it");
    const quiet = await (await fetch(`${servers.url}/alice/hello/pulls/${fresh}`)).text();
    expect(quiet).not.toContain("nobody pushed or commented since");
  }, 120_000);

  test("asking for a stopped preview redeploys it on the ordinary path", async () => {
    const idle = await until(() => {
      const e = runtime.status(record).find((x) => x.dormant !== undefined);
      return e === undefined ? undefined : Number(e.env.slice(5));
    });
    const before = listRuns(app.db, repo.id, { kind: "deploy", limit: 100 }).length;
    const res = await fetch(`${servers.url}/`, {
      headers: { host: `hello--${idle}.${DOMAIN}` },
    });
    expect([200, 503]).toContain(res.status);
    await running(idle);
    expect(envOf(idle)?.dormant).toBeUndefined();
    const runs = listRuns(app.db, repo.id, { kind: "deploy", limit: 100 });
    expect(runs.length).toBe(before + 1);
    expect(runs[0]!.reason).toBe("wake");
    // Woken, it counts as touched: the next sweep leaves it up.
    await Bun.sleep(500);
    expect(envOf(idle)?.state).toBe("running");
  }, 120_000);

  test("a restart leaves a sleeping preview asleep", async () => {
    const idle = await pull("later");
    age(idle, 5 * DAY);
    await until(() => (envOf(idle)?.dormant !== undefined ? true : undefined));
    const before = listRuns(app.db, repo.id, { kind: "deploy", limit: 100 }).filter(
      (r) => r.env === `pull-${idle}`,
    ).length;
    await runtime.stop();
    runtime = new AppsRuntime(app, options());
    await runtime.start();
    expect(envOf(idle)?.dormant).toBeDefined();
    expect(envOf(idle)?.state).toBe("stopped");
    await Bun.sleep(500);
    const after = listRuns(app.db, repo.id, { kind: "deploy", limit: 100 }).filter(
      (r) => r.env === `pull-${idle}`,
    ).length;
    expect(after).toBe(before);
  }, 120_000);
});
