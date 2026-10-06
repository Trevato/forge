/**
 * A pull from someone who cannot write the repository runs nothing — no
 * check, no preview — until a person who can write it approves that exact
 * head. A new push is a new head and needs a new approval. A writer's own
 * pull and the crew's run as they always have.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull, submitReview } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import type { AppRecord } from "../src/core/apps.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const checkJson = (run: string) =>
  `{"check": {"run": ${JSON.stringify(run)}, "install": ""}}\n`;

describe("a reader's fork pull runs nothing until a writer approves its head", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let checks: ChecksHandle;
  let runtime: AppsRuntime;
  let alice: User;
  let carol: User;
  let bot: User;
  let lib: Repo;
  let notes: Repo;
  let notesApp: AppRecord;

  const runsFor = (
    repo: Repo,
    kind: "check" | "deploy",
    pull: Pull,
    commit?: string,
  ) =>
    listRuns(app.db, repo.id, { kind, limit: 100 }).filter(
      (r) =>
        r.env === `pull-${pull.number}` &&
        (commit === undefined || r.commitOid === commit),
    );

  const forks = new Map<string, Repo>();

  /** Long enough for the event handlers to have queued whatever they would. */
  const settle = () => Bun.sleep(400);

  async function forkPull(
    who: User,
    repo: Repo,
    branch: string,
  ): Promise<{ pull: Pull; fork: Repo; head: string }> {
    // One fork per person and repository; each test takes its own branch.
    const key = `${who.id}:${repo.id}`;
    let fork = forks.get(key);
    if (fork === undefined) {
      const forked = await forkRepo(app, who, repo, `${repo.name}-fork`);
      if (!forked.ok) throw new Error(String(forked.error));
      fork = forked.value;
      forks.set(key, fork);
    }
    const committed = await commitToBranch(app, who, fork, {
      branch,
      message: "From the fork",
      files: [{ path: `${branch}.md`, content: "hi\n" }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const opened = await openPull(app, who, repo, {
      title: `From ${who.username}`,
      baseBranch: "main",
      headBranch: branch,
      headRepo: fork,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    expect(opened.value.crossRepo).toBe(true);
    return { pull: opened.value, fork, head: committed.value.commitOid };
  }

  const approve = async (who: User, repo: Repo, pull: Pull) => {
    const done = await submitReview(app, who, repo, pull, {
      state: "approved",
    });
    if (!done.ok) throw new Error(String(done.error));
    return done.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-fork-approval-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    checks = startChecks(app, { forgeUrl: servers.url, concurrency: 1 });
    runtime = new AppsRuntime(app, {
      domain: "apps.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    await runtime.start();
    const people: User[] = [];
    for (const [username, first] of [
      ["alice", true],
      ["carol", false],
    ] as const) {
      const made = await createUser(app.db, {
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
      people.push(made.value);
    }
    [alice, carol] = people as [User, User];
    const agent = await createAgent(app, alice, { username: "bot" });
    if (!agent.ok) throw new Error(String(agent.error));
    bot = agent.value.user;

    const made = await createRepo(app, alice, {
      name: "lib",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    lib = made.value;
    const declared = await commitToBranch(app, alice, lib, {
      message: "Declare a check",
      files: [{ path: "forge.json", content: checkJson("true") }],
    });
    if (!declared.ok) throw new Error(JSON.stringify(declared.error));
    expect(addToCrew(app, alice, lib, "bot").ok).toBe(true);

    const madeApp = await newApp(app, alice, {
      name: "notes",
      description: "Notes",
      visibility: "public",
    });
    if (!madeApp.ok) throw new Error(String(madeApp.error));
    notes = madeApp.value.repo;
    notesApp = madeApp.value.app;
  }, 120_000);

  afterAll(async () => {
    await checks.stop();
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a reader's fork pull queues no check", async () => {
    const { pull } = await forkPull(carol, lib, "readers");
    await settle();
    expect(runsFor(lib, "check", pull)).toHaveLength(0);
  });

  test("the pull's page says what it waits for, and stops saying it once approved", async () => {
    const { pull } = await forkPull(carol, lib, "page");
    const page = () =>
      fetch(`${servers.url}/alice/lib/pulls/${pull.number}`, {
        headers: { cookie: "forge_mode=dev" },
      }).then((r) => r.text());
    const first = await page();
    expect(first).toContain("wait for a writer to approve this head");
    await approve(alice, lib, pull);
    await settle();
    expect(await page()).not.toContain("wait for a writer to approve this head");
  });

  test("a reader's fork pull on an app deploys no preview", async () => {
    const { pull } = await forkPull(carol, notes, "readers");
    await settle();
    expect(runsFor(notes, "deploy", pull)).toHaveLength(0);
  });

  test("a writer's approval of that head starts the check and the preview", async () => {
    const one = await forkPull(carol, lib, "approved");
    const two = await forkPull(carol, notes, "approved");
    await settle();
    expect(runsFor(lib, "check", one.pull)).toHaveLength(0);
    await approve(alice, lib, one.pull);
    await approve(alice, notes, two.pull);
    await settle();
    expect(runsFor(lib, "check", one.pull, one.head).length).toBeGreaterThan(0);
    expect(runsFor(notes, "deploy", two.pull, two.head).length).toBeGreaterThan(
      0,
    );
  }, 60_000);

  test("a new push is a new head, and needs a new approval", async () => {
    const { pull, fork, head } = await forkPull(carol, lib, "pushes");
    await approve(alice, lib, pull);
    await settle();
    expect(runsFor(lib, "check", pull, head).length).toBeGreaterThan(0);
    const again = await commitToBranch(app, carol, fork, {
      branch: "pushes",
      message: "Again",
      files: [{ path: "pushes.md", content: "again\n" }],
    });
    if (!again.ok) throw new Error(JSON.stringify(again.error));
    await settle();
    expect(runsFor(lib, "check", pull, again.value.commitOid)).toHaveLength(0);
  }, 60_000);

  test("approval from the crew or from the pull's own reader does not count", async () => {
    const { pull } = await forkPull(carol, lib, "crewvote");
    const byBot = await submitReview(app, bot, lib, pull, {
      state: "approved",
    });
    expect(byBot.ok).toBe(true);
    const byCarol = await submitReview(app, carol, lib, pull, {
      state: "approved",
    });
    expect(byCarol.ok).toBe(false);
    await settle();
    expect(runsFor(lib, "check", pull)).toHaveLength(0);
  });

  test("a writer's own fork pull and the crew's run as before", async () => {
    const mine = await forkPull(alice, lib, "writers");
    const crews = await forkPull(bot, lib, "crews");
    await settle();
    expect(runsFor(lib, "check", mine.pull, mine.head).length).toBeGreaterThan(
      0,
    );
    expect(
      runsFor(lib, "check", crews.pull, crews.head).length,
    ).toBeGreaterThan(0);
  }, 60_000);

  test("a writer asking for changes on the approved head stops it running again", async () => {
    const { pull, head } = await forkPull(carol, lib, "turned");
    await approve(alice, lib, pull);
    await settle();
    expect(runsFor(lib, "check", pull, head).length).toBeGreaterThan(0);
    const turned = await submitReview(app, alice, lib, pull, {
      state: "changes_requested",
      body: "Not this.",
    });
    expect(turned.ok).toBe(true);
    const { pullMayRun } = await import("../src/core/pull_trust.ts");
    expect(pullMayRun(app.db, lib, pull, head)).toBe(false);
  });

  /** A reader's fork-pull preview on the app, approved and deployed. */
  async function deployedPreview(branch: string) {
    const { pull, head } = await forkPull(carol, notes, branch);
    await approve(alice, notes, pull);
    const env = `pull-${pull.number}`;
    const deadline = Date.now() + 90_000;
    while (
      !listRuns(app.db, notes.id, { kind: "deploy", limit: 100 }).some(
        (r) => r.env === env && r.commitOid === head && r.state === "ok",
      )
    ) {
      if (Date.now() > deadline) throw new Error("preview did not deploy");
      await Bun.sleep(200);
    }
    return { pull, head, env };
  }

  const envOf = (env: string) =>
    runtime.status(notesApp).find((e) => e.env === env);

  async function restart(): Promise<void> {
    await runtime.stop();
    runtime = new AppsRuntime(app, {
      domain: "apps.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    await runtime.start();
  }

  test("a preview asleep at a head nobody approved is taken down, not woken", async () => {
    const { pull, env } = await deployedPreview("sleeper");
    await restart();
    expect(envOf(env)?.state).toBe("asleep");
    // The approval goes after it fell asleep: waking asks again.
    app.db.run("DELETE FROM review WHERE issue_id = ?1", [pull.id]);
    expect(await runtime.wake(notesApp, env as never)).toBeUndefined();
    expect(envOf(env)).toBeUndefined();
  }, 120_000);

  test("at boot, a preview at a head nobody approved is taken down", async () => {
    const { pull, env } = await deployedPreview("booted");
    // As if it had been deployed before the gate: no approval stands.
    app.db.run("DELETE FROM review WHERE issue_id = ?1", [pull.id]);
    await restart();
    expect(envOf(env)).toBeUndefined();
  }, 120_000);

  test("a writer asking for changes on a running preview's head takes it down at once", async () => {
    const { pull, env } = await deployedPreview("running");
    expect(["running", "deploying"]).toContain(envOf(env)?.state ?? "");
    const turned = await submitReview(app, alice, notes, pull, {
      state: "changes_requested",
      body: "Not this.",
    });
    expect(turned.ok).toBe(true);
    const deadline = Date.now() + 10_000;
    while (envOf(env) !== undefined && Date.now() < deadline)
      await Bun.sleep(100);
    expect(envOf(env)).toBeUndefined();
  }, 120_000);

  test("a writer's own preview survives boot and a changes request", async () => {
    const mine = await commitToBranch(app, alice, notes, {
      branch: "own",
      message: "Own",
      files: [{ path: "OWN.md", content: "own\n" }],
    });
    if (!mine.ok) throw new Error(JSON.stringify(mine.error));
    const opened = await openPull(app, alice, notes, {
      title: "Own",
      baseBranch: "main",
      headBranch: "own",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const env = `pull-${opened.value.number}`;
    const deadline = Date.now() + 90_000;
    while (envOf(env)?.state !== "running") {
      if (Date.now() > deadline) throw new Error("preview did not deploy");
      await Bun.sleep(200);
    }
    await restart();
    expect(envOf(env)?.state).toBe("asleep");
  }, 120_000);
});
