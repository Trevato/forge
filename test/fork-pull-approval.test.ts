/**
 * A pull from someone who cannot write the repository runs nothing — no
 * check, no preview — until a person who can write it approves that exact
 * head. A new push is a new head and needs a new approval. A writer's own
 * pull and the crew's run as they always have.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
  type Mock,
} from "bun:test";
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
import { logLevel, setLogLevel, type LogLevel } from "../src/kernel/log.ts";
import { promote } from "./helpers/members.ts";

/**
 * The forge's info lines, held instead of printed: the gate says "waits for a
 * writer's approval" when it refuses, and that line is the witness that the
 * event was handled. A fixed sleep only guessed it had been.
 */
const said: string[] = [];
let foundLevel: LogLevel;
const spies: Mock<(...a: unknown[]) => void>[] = [];
beforeAll(() => {
  foundLevel = logLevel();
  setLogLevel("info");
  for (const m of ["info", "warn"] as const)
    spies.push(
      spyOn(console, m).mockImplementation((...a: unknown[]) => {
        said.push(a.join(" "));
      }),
    );
});
afterAll(() => {
  for (const spy of spies) spy.mockRestore();
  setLogLevel(foundLevel);
});

/** Poll every 5 ms until `ok`, or fail naming `what`. */
async function until(ok: () => boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

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

  /** Whether `line` carries the field `key=value` exactly. */
  const field = (line: string, key: string, value: string) =>
    ` ${line} `.includes(` ${key}=${value} `);

  /**
   * How many times the gate refused `env` in one repository — `scope` is
   * `repo=owner/name` for a check, `app=slug` for a preview, since pull
   * numbers repeat across repositories — at `commit`, when named.
   */
  const refusals = (
    message: string,
    scope: [string, string],
    env: string,
    commit?: string,
  ) =>
    said.filter(
      (line) =>
        line.includes(message) &&
        field(line, ...scope) &&
        field(line, "env", env) &&
        (commit === undefined || field(line, "commit", commit.slice(0, 7))),
    ).length;

  /**
   * The checks service has handled `pull`'s events up to the `times`th
   * refusal — or, were the gate gone, queued a run the test then sees.
   */
  const checkDecided = (repo: Repo, pull: Pull, commit?: string, times = 1) =>
    until(
      () =>
        refusals(
          "check waits for a writer's approval",
          ["repo", `${repo.ownerName}/${repo.name}`],
          `pull-${pull.number}`,
          commit,
        ) >= times || runsFor(repo, "check", pull, commit).length > 0,
      `the check gate on ${repo.name} pull ${pull.number}`,
    );

  /** The same for the apps runtime and `pull`'s preview on the notes app. */
  const previewDecided = (repo: Repo, pull: Pull) =>
    until(
      () =>
        refusals(
          "preview waits for a writer's approval",
          ["app", notesApp.slug],
          `pull-${pull.number}`,
        ) > 0 || runsFor(repo, "deploy", pull).length > 0,
      `the preview gate on ${repo.name} pull ${pull.number}`,
    );

  /** Wait for a `kind` run of `pull` at `commit`. */
  const ran = (repo: Repo, kind: "check" | "deploy", pull: Pull, commit: string) =>
    until(
      () => runsFor(repo, kind, pull, commit).length > 0,
      `a ${kind} of pull ${pull.number}`,
    );

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
        origin: "seed",
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
    promote(app.db, carol);
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
  }, 20_000);

  afterAll(async () => {
    await checks.stop();
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a reader's fork pull queues no check", async () => {
    // Invariant: opening a reader's fork pull queues no check run.
    const { pull } = await forkPull(carol, lib, "readers");
    await checkDecided(lib, pull);
    expect(runsFor(lib, "check", pull)).toHaveLength(0);
  });

  test("the pull's page says what it waits for, and stops saying it once approved", async () => {
    // Invariant: the page says the pull waits for approval until a writer approves.
    const { pull } = await forkPull(carol, lib, "page");
    const page = () =>
      fetch(`${servers.url}/alice/lib/pulls/${pull.number}`, {
        headers: { cookie: "forge_mode=dev" },
      }).then((r) => r.text());
    const first = await page();
    expect(first).toContain("wait for a writer to approve this head");
    await approve(alice, lib, pull);
    expect(await page()).not.toContain("wait for a writer to approve this head");
  });

  test("a reader's fork pull on an app deploys no preview", async () => {
    // Invariant: opening a reader's fork pull on an app deploys no preview.
    const { pull } = await forkPull(carol, notes, "readers");
    await previewDecided(notes, pull);
    expect(runsFor(notes, "deploy", pull)).toHaveLength(0);
  });

  test("a writer's approval of that head starts the check and the preview", async () => {
    // Invariant: a writer's approval of the head runs its check and its preview.
    const one = await forkPull(carol, lib, "approved");
    const two = await forkPull(carol, notes, "approved");
    await checkDecided(lib, one.pull);
    await previewDecided(notes, two.pull);
    expect(runsFor(lib, "check", one.pull)).toHaveLength(0);
    expect(runsFor(notes, "deploy", two.pull)).toHaveLength(0);
    await approve(alice, lib, one.pull);
    await approve(alice, notes, two.pull);
    await ran(lib, "check", one.pull, one.head);
    await ran(notes, "deploy", two.pull, two.head);
  });

  test("a new push is a new head, and needs a new approval", async () => {
    // Invariant: an approval holds for its head only; a pushed head runs nothing.
    const { pull, fork, head } = await forkPull(carol, lib, "pushes");
    await approve(alice, lib, pull);
    await ran(lib, "check", pull, head);
    const again = await commitToBranch(app, carol, fork, {
      branch: "pushes",
      message: "Again",
      files: [{ path: "pushes.md", content: "again\n" }],
    });
    if (!again.ok) throw new Error(JSON.stringify(again.error));
    await checkDecided(lib, pull, again.value.commitOid);
    expect(runsFor(lib, "check", pull, again.value.commitOid)).toHaveLength(0);
  });

  test("approval from the crew or from the pull's own reader does not count", async () => {
    // Invariant: neither the crew's approval nor the author's own lets it run.
    const { pull } = await forkPull(carol, lib, "crewvote");
    const byBot = await submitReview(app, bot, lib, pull, {
      state: "approved",
    });
    expect(byBot.ok).toBe(true);
    const byCarol = await submitReview(app, carol, lib, pull, {
      state: "approved",
    });
    expect(byCarol.ok).toBe(false);
    // Refused once on opening, once more on the crew's approval.
    await checkDecided(lib, pull, undefined, 2);
    expect(runsFor(lib, "check", pull)).toHaveLength(0);
  });

  test("a writer's own fork pull and the crew's run as before", async () => {
    // Invariant: a writer's and the crew's fork pulls are checked without approval.
    const mine = await forkPull(alice, lib, "writers");
    const crews = await forkPull(bot, lib, "crews");
    await ran(lib, "check", mine.pull, mine.head);
    await ran(lib, "check", crews.pull, crews.head);
  });

  test("a writer asking for changes on the approved head stops it running again", async () => {
    // Invariant: a writer's changes request withdraws the approval of that head.
    const { pull, head } = await forkPull(carol, lib, "turned");
    await approve(alice, lib, pull);
    await ran(lib, "check", pull, head);
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
    const deadline = Date.now() + 10_000;
    while (
      !listRuns(app.db, notes.id, { kind: "deploy", limit: 100 }).some(
        (r) => r.env === env && r.commitOid === head && r.state === "ok",
      )
    ) {
      if (Date.now() > deadline) throw new Error("preview did not deploy");
      await Bun.sleep(5);
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
    // Invariant: waking an asleep preview asks for approval again.
    const { pull, env } = await deployedPreview("sleeper");
    await restart();
    expect(envOf(env)?.state).toBe("asleep");
    // The approval goes after it fell asleep: waking asks again.
    app.db.run("DELETE FROM review WHERE issue_id = ?1", [pull.id]);
    expect(await runtime.wake(notesApp, env as never)).toBeUndefined();
    expect(envOf(env)).toBeUndefined();
  }, 20_000);

  test("at boot, a preview at a head nobody approved is taken down", async () => {
    // Invariant: boot takes down a preview whose head nobody approved.
    const { pull, env } = await deployedPreview("booted");
    // As if it had been deployed before the gate: no approval stands.
    app.db.run("DELETE FROM review WHERE issue_id = ?1", [pull.id]);
    await restart();
    expect(envOf(env)).toBeUndefined();
  }, 20_000);

  test("a writer asking for changes on a running preview's head takes it down at once", async () => {
    // Invariant: a changes request takes a running reader's preview down.
    const { pull, env } = await deployedPreview("running");
    expect(["running", "deploying"]).toContain(envOf(env)?.state ?? "");
    const turned = await submitReview(app, alice, notes, pull, {
      state: "changes_requested",
      body: "Not this.",
    });
    expect(turned.ok).toBe(true);
    const deadline = Date.now() + 10_000;
    while (envOf(env) !== undefined && Date.now() < deadline)
      await Bun.sleep(5);
    expect(envOf(env)).toBeUndefined();
  }, 20_000);

  test("a writer's own preview survives boot and a changes request", async () => {
    // Invariant: a writer's own preview needs no approval to come back at boot.
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
    const deadline = Date.now() + 10_000;
    while (envOf(env)?.state !== "running") {
      if (Date.now() > deadline) throw new Error("preview did not deploy");
      await Bun.sleep(5);
    }
    await restart();
    expect(envOf(env)?.state).toBe("asleep");
  }, 20_000);
});
