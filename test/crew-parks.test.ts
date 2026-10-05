/**
 * An interrupted run is not a park. A builder's run the provider's limit, an
 * unreachable API or a restart ended writes no park note and is no strike;
 * strikes count only since the last word from a person or the planner, and
 * the map's `parked` is the same rule that stops dispatch.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { setCrewRole } from "../src/core/agents.ts";
import { getIssueById, listComments, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { migrations } from "../src/core/schema.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { driveRepo, parkedCount, settleAgentRun } from "../src/crew/autonomy.ts";
import { breakerTripped } from "../src/crew/breaker.ts";
import {
  interruptedSummary,
  interruptionOf,
} from "../src/crew/interrupted.ts";
import { struckOut } from "../src/crew/parks.ts";

describe("which runs were interrupted", () => {
  test("the provider, the network and a restart; never the work itself", () => {
    expect(
      interruptionOf(
        "every subscription this repository may use is resting (You've hit your weekly limit)",
      ),
    ).toBe("provider limit");
    expect(interruptionOf("no changes pushed (api_error)")).toBe("provider limit");
    expect(interruptionOf("the run failed: TypeError: fetch failed")).toBe(
      "network error",
    );
    expect(interruptionOf("cancelled")).toBe("restart");
    expect(interruptionOf("no changes pushed: DECLINED: out of scope")).toBe(
      undefined,
    );
    expect(interruptionOf("declined: a rate limit is not mine to change")).toBe(
      undefined,
    );
    expect(interruptionOf("the check stayed red")).toBe(undefined);
  });

  test("the summary says the cause and when it resumes", () => {
    const said = interruptedSummary(
      "every subscription this repository may use is resting (weekly limit)",
      new Date("2026-10-03T02:00:00Z"),
    );
    expect(said).toStartWith("interrupted: provider limit, resumes 02:00 UTC — ");
    expect(interruptionOf(said)).toBe("provider limit");
    expect(interruptedSummary(said)).toBe(said);
    expect(interruptedSummary("nothing to propose")).toBe("nothing to propose");
  });
});

describe("an interrupted run is not a park", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let atlas: User;
  let mason: User;
  let repo: Repo;
  const fresh = () => getRepoById(app.db, repo.id)!;
  const tick = () => Bun.sleep(5);
  const issue = (title: string): Issue => {
    const made = openIssue(app, alice, fresh(), { title });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  /** A builder's run on the issue that ends without a pull, settled as the crew would. */
  const ended = (on: Issue, summary: string): boolean => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: on.id,
      actorId: mason.id,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    const recorded = interruptedSummary(summary);
    finishRun(app.db, run.id, { state: "failed", summary: recorded });
    return settleAgentRun(app, fresh(), {
      issueId: on.id,
      state: "failed",
      summary: recorded,
      reason: "assigned",
      actorId: mason.id,
    });
  };
  const parks = (on: Issue) =>
    listComments(app.db, on.id).filter((c) =>
      c.body.startsWith("Parked by the crew"),
    );

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-parks-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, {
      name: "engine",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    for (const name of ["atlas", "mason"]) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(app, alice, repo, name).ok).toBe(true);
    }
    atlas = getUserByName(app.db, "atlas")!;
    mason = getUserByName(app.db, "mason")!;
    setCrewRole(app.db, repo.id, atlas.id, "planner");
    const set = await updateRepoSettings(app, alice, repo, {
      autonomy: "autonomous",
      autonomyDirection: "Keep the engine small.",
      autonomyCeilingUsd: 100,
      autonomyBy: alice.id,
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an outage run writes no park note, no strike, and the clock tries it again", async () => {
    const work = issue("Shader hot reload");
    for (const summary of [
      "every subscription this repository may use is resting (You've hit your weekly limit)",
      "the run failed: TypeError: fetch failed",
      "cancelled",
    ]) {
      expect(ended(work, summary)).toBe(false);
      await tick();
    }
    expect(parks(work)).toEqual([]);
    expect(parkedCount(app, fresh(), work.id)).toBe(0);
    // Three outages inside the hour are not three failures.
    expect(breakerTripped(app.db, work.id)).toBe(false);
    // Not stalled: nobody needs to speak for it to be picked again.
    expect(await driveRepo(app, fresh())).toBe("picked");
    expect(getIssueById(app.db, work.id)!.assigneeId).toBe(mason.id);
  });

  test("the issue page says the run was interrupted, and when it resumes", async () => {
    const work = issue("Input mapping");
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: work.id,
      actorId: mason.id,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, {
      state: "failed",
      summary: interruptedSummary(
        "every subscription this repository may use is resting (weekly limit)",
        new Date("2026-10-03T02:00:00Z"),
      ),
    });
    const cookie = (
      (
        await fetch(`${servers.url}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "alice",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    const page = await (
      await fetch(`${servers.url}/alice/engine/issues/${work.number}`, {
        headers: { cookie },
      })
    ).text();
    expect(page).toContain("interrupted: provider limit, resumes 02:00 UTC");
  });

  test("two real parks strike it out, on the map as in dispatch", async () => {
    const work = issue("Scene graph");
    expect(ended(work, "no changes pushed: DECLINED: out of scope")).toBe(true);
    await tick();
    expect(parkedCount(app, fresh(), work.id)).toBe(1);
    expect(struckOut(app.db, fresh(), [work.id]).has(work.id)).toBe(false);
    expect(ended(work, "nothing to propose")).toBe(true);
    expect(parkedCount(app, fresh(), work.id)).toBe(2);
    expect(struckOut(app.db, fresh(), [work.id]).has(work.id)).toBe(true);
  });

  test("a word from the planner or a person counts again from zero; a builder's does not", async () => {
    const work = issue("Physics step");
    ended(work, "nothing to propose");
    await tick();
    ended(work, "nothing to propose");
    await tick();
    expect(parkedCount(app, fresh(), work.id)).toBe(2);
    // The builder's own report is not a re-plan.
    addComment(app, mason, fresh(), getIssueById(app.db, work.id)!, "Tried twice.");
    await tick();
    expect(parkedCount(app, fresh(), work.id)).toBe(2);
    addComment(
      app,
      atlas,
      fresh(),
      getIssueById(app.db, work.id)!,
      "Split: only the fixed step here.",
    );
    await tick();
    expect(parkedCount(app, fresh(), work.id)).toBe(0);
    expect(struckOut(app.db, fresh(), [work.id]).has(work.id)).toBe(false);
    ended(work, "nothing to propose");
    await tick();
    expect(parkedCount(app, fresh(), work.id)).toBe(1);
    ended(work, "nothing to propose");
    await tick();
    addComment(app, alice, fresh(), getIssueById(app.db, work.id)!, "Try the fixed step.");
    expect(parkedCount(app, fresh(), work.id)).toBe(0);
  });
});

describe("migration 43", () => {
  test("rewords old outage parks so they no longer count, and leaves real parks", () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE comment (id TEXT PRIMARY KEY, issue_id TEXT, author_id TEXT, body TEXT)",
    );
    const bodies = [
      "Parked by the crew: the run ended without a pull: every subscription this repository may use is resting (You've hit your weekly limit)",
      "Parked by the crew: the run ended without a pull: the run failed: Error: API unreachable",
      "Parked by the crew: the run ended without a pull: cancelled",
      "Parked by the crew: the run ended without a pull: nothing to propose",
      "Parked by the crew: the check stayed red past its tries.",
    ];
    bodies.forEach((body, n) =>
      db
        .query("INSERT INTO comment VALUES (?1, 'i', 'u', ?2)")
        .run(String(n), body),
    );
    db.exec(migrations[42]!);
    const after = db
      .query<{ body: string }, []>("SELECT body FROM comment ORDER BY id")
      .all()
      .map((r) => r.body);
    expect(after[0]).toBe(
      "Interrupted, not parked: the run ended without a pull: every subscription this repository may use is resting (You've hit your weekly limit)",
    );
    expect(after[1]).toStartWith("Interrupted, not parked: ");
    expect(after[2]).toStartWith("Interrupted, not parked: ");
    expect(after[3]).toBe(bodies[3]!);
    expect(after[4]).toBe(bodies[4]!);
  });
});
