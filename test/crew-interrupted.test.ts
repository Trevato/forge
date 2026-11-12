import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addComment, assignIssue, openIssue } from "../src/actions/issues.ts";
import { listComments } from "../src/core/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import {
  cancelRun,
  claimRun,
  createRun,
  getRun,
  listQueued,
  listRuns,
} from "../src/core/runs.ts";
import { listPulls } from "../src/core/pulls.ts";
import { getAgent } from "../src/core/agents.ts";
import { readRunLog } from "../src/runs/log.ts";
import { claimWorkdir, isClaimed, workdirFor } from "../src/crew/workdir.ts";
import { STALE_AFTER_MS } from "../src/runs/lease.ts";
import { createUser, type User } from "../src/core/users.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { serve, type Servers } from "../src/http/server.ts";

/** The crew's tick, injected short: every wait below is for the next tick (#11053). */
const TICK_MS = 50;
/** How often a test looks again at a run it waits on. */
const POLL_MS = 20;

describe("a run the last forge left running", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let crew: CrewHandle | undefined;
  let alice: User;
  let bot: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-interrupted-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createAgent(app, alice, { username: "bot" });
    if (!made.ok) throw new Error(String(made.error));
    bot = made.value.user;
  });

  afterAll(async () => {
    await crew?.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /**
   * No crew left up and no run left queued or running by the test before:
   * with no crew up, a running run is a leftover, and the next crew's tick
   * would requeue it once its lease lapsed or count it against a slot. Each
   * test starts from rest, so they pass in any order (`--randomize`).
   */
  const atRest = async () => {
    await crew?.stop();
    crew = undefined;
    const left = app.db
      .query<{ id: string }, []>(
        "SELECT id FROM run WHERE state IN ('queued', 'running')",
      )
      .all();
    for (const { id } of left) cancelRun(app.db, id, "cleared for the next test");
  };

  /** A repository of the test's own, with the bot on its crew: no case shares one. */
  const crewedRepo = async (name: string) => {
    const created = await createRepo(app, alice, {
      name,
      visibility: "private",
    });
    if (!created.ok) throw new Error(String(created.error));
    expect(addToCrew(app, alice, created.value, "bot").ok).toBe(true);
    return created.value;
  };

  /** Poll a run until it ends (ok, failed or cancelled), or the deadline passes. */
  const settled = async (id: string, withinMs: number) => {
    const deadline = Date.now() + withinMs;
    while (
      !["ok", "failed", "cancelled"].includes(getRun(app.db, id)!.state) &&
      Date.now() < deadline
    )
      await Bun.sleep(POLL_MS);
    return getRun(app.db, id)!;
  };

  /** Concurrency 0: the crew boots, tidies, and starts nothing. */
  const idleCrew = () =>
    startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: join(dataDir, "no-such-claude"),
      concurrency: 0,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
      tickMs: TICK_MS,
      networkRetryScale: 0,
    });

  test("is cancelled at boot and queued again under the same reason", async () => {
    await atRest();
    const repo = await crewedRepo("garden");
    const issued = openIssue(app, alice, repo, {
      title: "Plant something",
      body: "",
    });
    if (!issued.ok) throw new Error(String(issued.error));
    const issue = issued.value;

    // The previous forge claimed this run and died mid-way.
    const orphan = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.id,
      actorId: bot.id,
      reason: "feedback",
    });
    claimRun(app.db, orphan.id);
    expect(getRun(app.db, orphan.id)?.state).toBe("running");
    // …and its lease lapsed with it: nobody has renewed it since.
    app.db
      .query("UPDATE run SET heartbeat_at = ?2 WHERE id = ?1")
      .run(
        orphan.id,
        new Date(Date.now() - STALE_AFTER_MS - 1_000).toISOString(),
      );
    // A run whose lease is fresh is another forge's live work — the old
    // process of a release, finishing beside this one — and is left to it.
    const alive = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.id,
      actorId: bot.id,
      reason: "feedback",
    });
    claimRun(app.db, alive.id);

    crew = await idleCrew();

    const after = getRun(app.db, orphan.id)!;
    expect(after.state).toBe("cancelled");
    expect(after.summary).toContain("interrupted by a restart");
    const queued = listQueued(app.db, "agent").filter(
      (r) => r.issueId === issue.id && r.state === "queued",
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]!.reason).toBe("feedback");
    expect(queued[0]!.actorId).toBe(bot.id);
    expect(getRun(app.db, alive.id)?.state).toBe("running");
    // The other forge finishes it; here, it is simply out of the way.
    cancelRun(app.db, alive.id, "finished elsewhere");
  }, 30_000);

  test("a run whose lease lapses while the crew is up is queued again on the next tick", async () => {
    await atRest();
    const repo = await crewedRepo("allotment");
    // The crew is up before the lease lapses: only a tick can see it.
    crew = await idleCrew();
    const issued = openIssue(app, alice, repo, {
      title: "Water it",
      body: "",
    });
    if (!issued.ok) throw new Error(String(issued.error));
    const issue = issued.value;
    // A forge that fell and was back within the lease: at boot this run
    // still looked alive, and only later did nobody renew it.
    const orphan = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.id,
      actorId: bot.id,
      reason: "feedback",
    });
    claimRun(app.db, orphan.id);
    app.db
      .query("UPDATE run SET heartbeat_at = ?2 WHERE id = ?1")
      .run(
        orphan.id,
        new Date(Date.now() - STALE_AFTER_MS - 1_000).toISOString(),
      );
    const deadline = Date.now() + 15_000;
    while (
      getRun(app.db, orphan.id)?.state === "running" &&
      Date.now() < deadline
    )
      await Bun.sleep(POLL_MS);
    const after = getRun(app.db, orphan.id)!;
    expect(after.state).toBe("cancelled");
    expect(after.summary).toContain("interrupted by a restart");
    const queued = listQueued(app.db, "agent").filter(
      (r) => r.issueId === issue.id && r.state === "queued",
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]!.attempt).toBe(1);
  }, 30_000);

  test("a run in flight when the crew stops goes back on the queue", async () => {
    await atRest();
    const created = await createRepo(app, alice, {
      name: "orchard",
      visibility: "private",
    });
    if (!created.ok) throw new Error(String(created.error));
    const repo = created.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# orchard\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
    const issued = openIssue(app, alice, repo, { title: "Prune", body: "" });
    if (!issued.ok) throw new Error(String(issued.error));
    const issue = issued.value;
    // The word the follow-up answers: a follow-up with nothing new never starts.
    expect(
      addComment(app, alice, repo, issue, "The low branches first.").ok,
    ).toBe(true);
    // A stand-in that never finishes on its own.
    const slow = join(dataDir, "slow-claude");
    writeFileSync(
      slow,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
cat > /dev/null &
echo '{"type":"system","subtype":"init","session_id":"slow-1","model":"fake"}'
sleep 120
`,
    );
    chmodSync(slow, 0o755);
    const queuedRun = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.id,
      actorId: bot.id,
      reason: "feedback",
    });
    crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: slow,
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
      tickMs: TICK_MS,
      networkRetryScale: 0,
    });
    const deadline = Date.now() + 20_000;
    while (
      getRun(app.db, queuedRun.id)?.state !== "running" &&
      Date.now() < deadline
    )
      await Bun.sleep(POLL_MS);
    expect(getRun(app.db, queuedRun.id)?.state).toBe("running");

    await crew.stop();
    crew = undefined;

    const ended = getRun(app.db, queuedRun.id)!;
    expect(ended.state === "cancelled" || ended.state === "failed").toBe(true);
    const again = listQueued(app.db, "agent").filter(
      (r) => r.issueId === issue.id && r.state === "queued",
    );
    expect(again).toHaveLength(1);
    expect(again[0]!.reason).toBe("feedback");
    // …and carries on where it stopped: the clone is kept, the session resumed.
    expect(again[0]!.attempt).toBe(1);
    expect(again[0]!.summary).toContain("carries on");
  }, 40_000);

  test("a draining crew hands a long run back queued within its budget (#7799)", async () => {
    await atRest();
    const created = await createRepo(app, alice, { name: "thicket", visibility: "private" });
    if (!created.ok) throw new Error(String(created.error));
    const repo = created.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# thicket\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
    const issued = openIssue(app, alice, repo, { title: "Clear", body: "" });
    if (!issued.ok) throw new Error(String(issued.error));
    const issue = issued.value;
    const long = join(dataDir, "long-claude");
    writeFileSync(
      long,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
cat > /dev/null &
echo '{"type":"system","subtype":"init","session_id":"long-1","model":"fake"}'
sleep 120
`,
    );
    chmodSync(long, 0o755);
    const queuedRun = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.id,
      actorId: bot.id,
      reason: "assigned",
    });
    crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: long,
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
      tickMs: TICK_MS,
      networkRetryScale: 0,
    });
    const deadline = Date.now() + 20_000;
    while (getRun(app.db, queuedRun.id)?.state !== "running" && Date.now() < deadline) await Bun.sleep(POLL_MS);
    expect(getRun(app.db, queuedRun.id)?.state).toBe("running");

    const started = Date.now();
    await crew.stop({ drain: true, drainMs: 250 });
    crew = undefined;
    expect(Date.now() - started).toBeLessThan(15_000);

    const ended = getRun(app.db, queuedRun.id)!;
    expect(ended.state === "cancelled" || ended.state === "failed").toBe(true);
    const again = listQueued(app.db, "agent").filter((r) => r.issueId === issue.id && r.state === "queued");
    expect(again).toHaveLength(1);
    expect(again[0]!.summary).toContain("carries on");
  }, 40_000);

  test("a draining crew lets a run in flight finish and land; nothing is queued again", async () => {
    await atRest();
    const created = await createRepo(app, alice, {
      name: "grove",
      visibility: "private",
    });
    if (!created.ok) throw new Error(String(created.error));
    const repo = created.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# grove\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
    const issued = openIssue(app, alice, repo, { title: "Water", body: "" });
    if (!issued.ok) throw new Error(String(issued.error));
    const issue = issued.value;
    // A stand-in that takes its time, then finishes properly.
    const brief = join(dataDir, "brief-claude");
    writeFileSync(
      brief,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
cat > /dev/null &
echo '{"type":"system","subtype":"init","session_id":"brief-1","model":"fake"}'
sleep 0.5
echo "drained work" >> CREW.md
git add -A && git commit -qm "drained" && git push -q -u origin HEAD
echo '{"type":"result","subtype":"success","is_error":false,"result":"Done while draining.","total_cost_usd":0.01,"num_turns":2,"session_id":"brief-1","terminal_reason":"completed"}'
`,
    );
    chmodSync(brief, 0o755);
    const queuedRun = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.id,
      actorId: bot.id,
      reason: "assigned",
    });
    crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: brief,
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
      tickMs: TICK_MS,
      networkRetryScale: 0,
    });
    const deadline = Date.now() + 20_000;
    while (
      getRun(app.db, queuedRun.id)?.state !== "running" &&
      Date.now() < deadline
    )
      await Bun.sleep(POLL_MS);
    expect(getRun(app.db, queuedRun.id)?.state).toBe("running");

    await crew.stop({ drain: true, drainMs: 30_000 });
    crew = undefined;

    // The run's end, however long the machine took to reach it.
    const ended = await settled(queuedRun.id, 20_000);
    expect(ended.state).toBe("ok");
    expect(ended.summary).toMatch(/^opened pull #\d+/);
    expect(
      listQueued(app.db, "agent").filter((r) => r.issueId === issue.id),
    ).toHaveLength(0);
  }, 40_000);

  const keptClone = async (name: string) => {
    await atRest();
    const created = await createRepo(app, alice, {
      name,
      visibility: "private",
    });
    if (!created.ok) throw new Error(String(created.error));
    const repo = created.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# meadow\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
    const issued = openIssue(app, alice, repo, { title: "Mow", body: "" });
    if (!issued.ok) throw new Error(String(issued.error));
    const issue = issued.value;
    const fake = join(dataDir, "lock-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
cat > /dev/null &
echo '{"type":"system","subtype":"init","session_id":"lock-1","model":"fake"}'
echo "mowed $(date +%s%N)" >> CREW.md
git add -A && git commit -qm "mowed" && git push -q -u origin HEAD
echo '{"type":"result","subtype":"success","is_error":false,"result":"Done.","total_cost_usd":0.01,"num_turns":2,"session_id":"lock-1","terminal_reason":"completed"}'
`,
    );
    chmodSync(fake, 0o755);
    const options = {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: fake,
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
      tickMs: TICK_MS,
      networkRetryScale: 0,
    };
    const first = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.id,
      actorId: bot.id,
      reason: "assigned",
    });
    crew = await startCrew(app, options);
    expect((await settled(first.id, 25_000)).state).toBe("ok");

    // The clone is kept while the pull is open; a cut-off run left a lock.
    const agent = getAgent(app.db, bot.id)!;
    const clone = workdirFor(app.config.dataDir, agent, repo, issue.number);
    expect(existsSync(join(clone, ".git"))).toBe(true);
    return { repo, issue, clone };
  };

  const followUp = async (
    repo: Awaited<ReturnType<typeof keptClone>>["repo"],
  ) => {
    const pull = listPulls(app.db, repo.id)[0];
    expect(pull).toBeDefined();
    expect(
      addComment(app, alice, repo, pull!, "Closer to the fence, please.").ok,
    ).toBe(true);
    const deadline = Date.now() + 25_000;
    let next;
    while (Date.now() < deadline) {
      next = listRuns(app.db, repo.id, { issueId: pull!.id })[0];
      if (next && ["ok", "failed", "cancelled"].includes(next.state)) break;
      await Bun.sleep(POLL_MS);
    }
    expect(next).toBeDefined();
    return next!;
  };

  test("a kept clone with a stale git lock resumes cleanly and the lock is gone", async () => {
    const { repo, clone } = await keptClone("meadow");
    const lock = join(clone, ".git", "config.lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    const next = await followUp(repo);
    expect(next.summary ?? "").not.toContain("checkout failed");
    expect(existsSync(lock)).toBe(false);
  }, 60_000);

  test("a young lock that blocks checkout is recovered by a fresh clone", async () => {
    const { repo, clone } = await keptClone("copse");
    const lock = join(clone, ".git", "index.lock");
    writeFileSync(lock, "");
    const next = await followUp(repo);
    expect(next.state).toBe("ok");
    expect(existsSync(lock)).toBe(false);
  }, 60_000);

  test("a leftover directory with files and no .git never fails the run (#8219)", async () => {
    const { repo, clone } = await keptClone("bramble");
    rmSync(join(clone, ".git"), { recursive: true, force: true });
    const next = await followUp(repo);
    expect(next.summary ?? "").not.toContain("clone failed");
    expect(next.state).toBe("ok");
    expect(existsSync(join(clone, ".git", "HEAD"))).toBe(true);
  }, 60_000);

  test("a run that finds the issue's clone held works in a clone of its own (#8219)", async () => {
    const { repo, clone } = await keptClone("orchard-held");
    // Another live run holds the clone, and has uncommitted work in it.
    const other = claimWorkdir(clone, "otherrun");
    writeFileSync(join(clone, "held.txt"), "mine");
    const next = await followUp(repo);
    expect(next.state).toBe("ok");
    expect(readRunLog(app.config.dataDir, next.id).lines.some((l) => l.includes("another run holds the issue's clone"))).toBe(true);
    // The held clone is untouched (a reset and clean would have taken the file)…
    expect(existsSync(join(clone, "held.txt"))).toBe(true);
    // …and the run's own clone is gone with it.
    expect(readdirSync(dirname(clone)).some((n) => n.startsWith(`${basename(clone)}.run-`))).toBe(false);
    await other.release();
  }, 60_000);

  test("a run that throws after claiming its clone frees the claim (#8219)", async () => {
    const { repo, clone } = await keptClone("orchard-throw");
    // A file where the clone should be: reading it as a directory throws.
    rmSync(clone, { recursive: true, force: true });
    writeFileSync(clone, "not a directory");
    const next = await followUp(repo);
    expect(next.state).toBe("failed");
    expect(isClaimed(clone)).toBe(false);
    rmSync(clone, { force: true });
  }, 60_000);

  test("a kept clone git no longer reads is moved aside and cloned afresh (#6263)", async () => {
    const { repo, clone } = await keptClone("hedgerow");
    // What a clone cut short by a network blip leaves: `.git` without its HEAD.
    rmSync(join(clone, ".git", "HEAD"));
    const next = await followUp(repo);
    expect(next.summary ?? "").not.toContain("not a git repository");
    expect(next.state).toBe("ok");
    expect(existsSync(join(clone, ".git", "HEAD"))).toBe(true);
    const parent = dirname(clone);
    expect(readdirSync(parent).some((name) => name.startsWith(`${basename(clone)}.broken-`))).toBe(true);
  }, 60_000);

  test("a young lock is not worked around when the clone holds unpushed commits", async () => {
    const { repo, clone } = await keptClone("paddock");
    writeFileSync(join(clone, "LOST.md"), "unpushed\n");
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", ...args], { cwd: clone });
    git("add", "LOST.md");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "local");
    writeFileSync(join(clone, ".git", "index.lock"), "");
    const next = await followUp(repo);
    expect(next.state).toBe("failed");
    expect(next.summary ?? "").toContain("never pushed");
    expect(existsSync(join(clone, "LOST.md"))).toBe(true);
  }, 60_000);
});

describe("an issue handed to someone else", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let crew: CrewHandle;
  let alice: User;
  let bot: User;
  let other: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-reassign-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const one = await createAgent(app, alice, { username: "bot" });
    const two = await createAgent(app, alice, { username: "other" });
    if (!one.ok || !two.ok) throw new Error("agents");
    bot = one.value.user;
    other = two.value.user;
    crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: join(dataDir, "no-such-claude"),
      concurrency: 0,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
      tickMs: TICK_MS,
      networkRetryScale: 0,
    });
  });

  afterAll(async () => {
    await crew.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function setup(name: string) {
    const made = await createRepo(app, alice, { name, visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const repo = made.value;
    addToCrew(app, alice, repo, "bot");
    addToCrew(app, alice, repo, "other");
    const issued = openIssue(app, alice, repo, { title: "Work", body: "" });
    if (!issued.ok) throw new Error(String(issued.error));
    return { repo, issue: issued.value };
  }

  const queuedRun = (repoId: string, issueId: string, actorId: string) =>
    createRun(app.db, {
      repoId,
      kind: "agent",
      issueId,
      actorId,
      reason: "assigned",
    });

  test("a person taking it cancels the queued run, and their word starts none", async () => {
    const { repo, issue } = await setup("to-person");
    const run = queuedRun(repo.id, issue.id, bot.id);
    expect(assignIssue(app, alice, repo, issue, alice).ok).toBe(true);
    expect(getRun(app.db, run.id)?.state).toBe("cancelled");
    const said = listComments(app.db, issue.id).map((c) => c.body);
    expect(said.some((b) => b.includes("@alice") && b.includes("@bot"))).toBe(
      true,
    );
    const talk = addComment(app, alice, repo, issue, "I have this one");
    expect(talk.ok).toBe(true);
    expect(
      listQueued(app.db, "agent").some((r) => r.issueId === issue.id),
    ).toBe(false);
  });

  test("another agent taking it stops the running run and queues its own", async () => {
    const { repo, issue } = await setup("to-agent");
    const run = queuedRun(repo.id, issue.id, bot.id);
    claimRun(app.db, run.id);
    expect(assignIssue(app, alice, repo, issue, other).ok).toBe(true);
    expect(getRun(app.db, run.id)?.state).toBe("cancelled");
    const queued = listQueued(app.db, "agent").filter(
      (r) => r.issueId === issue.id,
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]!.actorId).toBe(other.id);
  });
});
