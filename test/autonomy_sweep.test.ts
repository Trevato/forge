/**
 * Landing never stalls the crew (#2015): the green sweep runs beside the
 * tick, not in front of it. A landing gate takes minutes; the tick picks a
 * builder meanwhile, and a second tick during one sweep starts no second.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { getIssue, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { autonomyTick, startSweep } from "../src/crew/autonomy.ts";

/** A sweep whose landing gate takes 10 s, released early by the test. */
function slowSweep() {
  let calls = 0;
  const pending: Array<() => void> = [];
  const sweep = (_app: App, _repo: Repo) => {
    calls++;
    return new Promise<number>((resolve) => {
      const timer = setTimeout(() => resolve(1), 10_000);
      pending.push(() => {
        clearTimeout(timer);
        resolve(1);
      });
    });
  };
  return {
    sweep,
    calls: () => calls,
    release: () => {
      for (const done of pending.splice(0)) done();
    },
  };
}

describe("the green sweep runs beside the tick", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  let issue: Issue;
  const fresh = () => getRepoById(app.db, repo.id)!;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-sweep-"));
    app = createApp({ dataDir, port: 0 });
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
    const made = await createRepo(app, alice, { name: "engine", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const agent = await createAgent(app, alice, { username: "mason" });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, repo, "mason").ok).toBe(true);
    const opened = openIssue(app, alice, repo, { title: "Renderer" });
    if (!opened.ok) throw new Error(String(opened.error));
    issue = opened.value;
    const on = await updateRepoSettings(app, alice, repo, {
      autonomy: "autonomous",
      autonomyDirection: "Pull the engine out of the game.",
      autonomyCeilingUsd: 10,
      autonomySlots: 1,
      autonomyBy: alice.id,
    });
    expect(on.ok).toBe(true);
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a landing gate that takes 10 s does not delay the tick's pick; two ticks start one sweep", async () => {
    const slow = slowSweep();
    const started = Date.now();
    await autonomyTick(app, new Date(), slow.sweep);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(slow.calls()).toBe(1);
    expect(getIssue(app.db, repo.id, issue.number)!.assigneeId).not.toBeNull();

    // A second tick while the first sweep is still landing joins it.
    await autonomyTick(app, new Date(), slow.sweep);
    expect(slow.calls()).toBe(1);

    // Once it settles, the next tick sweeps again.
    slow.release();
    await Bun.sleep(0);
    await autonomyTick(app, new Date(), slow.sweep);
    expect(slow.calls()).toBe(2);
    slow.release();
  });

  test("a sweep in flight is shared, and a failed one is logged and cleared", async () => {
    const slow = slowSweep();
    const first = startSweep(app, fresh(), slow.sweep);
    expect(startSweep(app, fresh(), slow.sweep)).toBe(first);
    slow.release();
    expect(await first).toBe(1);

    const failed = startSweep(app, fresh(), async () => {
      throw new Error("gate fell over");
    });
    expect(await failed).toBe(0);
    const again = slowSweep();
    const next = startSweep(app, fresh(), again.sweep);
    expect(next).not.toBe(failed);
    expect(again.calls()).toBe(1);
    again.release();
    await next;
  });
});
