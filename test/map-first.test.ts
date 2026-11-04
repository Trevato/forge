/**
 * "This first" (#7806): a writer's rank puts a ready issue ahead of the rest
 * for the dispatcher; it never lifts a blocker, and it ends when the issue closes.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import {} from "../src/core/agents.ts";
import { addDependency, readyNow, repoGraph } from "../src/core/dependencies.ts";
import { firstAt, putFirst } from "../src/core/first.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { driveRepo } from "../src/crew/autonomy.ts";

describe("this first", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  const fresh = () => getRepoById(app.db, repo.id)!;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-first-"));
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
    const made = await createRepo(app, alice, { name: "plan", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    for (const agent of ["atlas", "mason"]) {
      const created = await createAgent(app, alice, { username: agent });
      if (!created.ok) throw new Error(String(created.error));
      expect(addToCrew(app, alice, made.value, agent).ok).toBe(true);
    }
    seatAs(app.db, made.value.id, getUserByName(app.db, "atlas")!.id, "planner");
    const set = await updateRepoSettings(app, alice, made.value, {
      autonomy: "autonomous",
      autonomyDirection: "Keep the engine small.",
      autonomyCeilingUsd: 100,
      autonomySlots: 1,
      autonomyBy: alice.id,
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    repo = getRepoById(app.db, made.value.id)!;
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const make = (title: string): Issue => {
    const opened = openIssue(app, alice, fresh(), { title });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };
  const readyNumbers = () => readyNow(repoGraph(app.db, repo.id)).map((r) => r.issue.number);

  test("with A and B ready, ranking B makes autonomy assign B next", async () => {
    const a = make("Alpha work");
    const b = make("Beta work");
    expect(readyNumbers()).toEqual([a.number, b.number]);
    const ranked = putFirst(app, alice, fresh(), b);
    expect(ranked.ok).toBe(true);
    expect(readyNumbers()).toEqual([b.number, a.number]);
    expect(await driveRepo(app, fresh())).toBe("picked");
    expect(getIssueById(app.db, b.id)!.assigneeId).toBe(getUserByName(app.db, "mason")!.id);
    expect(getIssueById(app.db, a.id)!.assigneeId).toBeNull();
    const event = app.db
      .query<{ actor_id: string }, []>("SELECT actor_id FROM event WHERE kind = 'issue.first'")
      .get();
    expect(event?.actor_id).toBe(alice.id);
  });

  test("a blocked, closed or agent-ranked issue is refused, and closing clears the rank", () => {
    const blocker = make("Blocker");
    const waiter = make("Waiter");
    addDependency(app.db, waiter, blocker, alice.id);
    expect(putFirst(app, alice, fresh(), waiter)).toEqual({ ok: false, error: "invalid" });
    expect(readyNumbers()).not.toContain(waiter.number);
    const mason = getUserByName(app.db, "mason")!;
    expect(putFirst(app, mason, fresh(), blocker)).toEqual({ ok: false, error: "forbidden" });
    expect(putFirst(app, alice, fresh(), blocker).ok).toBe(true);
    expect(firstAt(app.db, [blocker.id]).size).toBe(1);
    expect(setIssueState(app, alice, fresh(), getIssueById(app.db, blocker.id)!, "closed").ok).toBe(true);
    expect(firstAt(app.db, [blocker.id]).size).toBe(0);
    expect(putFirst(app, alice, fresh(), getIssueById(app.db, blocker.id)!)).toEqual({ ok: false, error: "invalid" });
  });
});
