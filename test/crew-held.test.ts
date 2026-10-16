/**
 * Why each ready issue cannot start (#2244): an issue held by each filter
 * is counted under that filter's name, the tick's words say the counts,
 * and a crew with free slots and nothing startable asks the planner once,
 * with the breakdown — a full plate does not hold it. /flow and the
 * terminal's Flow dialog show the same counts, private repositories to the
 * owner only. Each test makes its own repository and crew.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addComment, assignIssue, openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { getAgentByName, setCrewRole } from "../src/core/agents.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { driveRepo } from "../src/crew/autonomy.ts";
import { taskPrompt } from "../src/crew/brief.ts";
import { ISSUE_RUN_CAP } from "../src/crew/guard.ts";
import { heldCounts, heldNow, heldWords, stuckOf } from "../src/crew/held.ts";
import { PARK_NOTE } from "../src/crew/parks.ts";
import { keyPart } from "../src/crew/sentinel.ts";
import { HELD_TTL_MS, readHeld } from "../src/flow/held.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { flowLines, heldLines } from "../src/tui/screens/flow.ts";

const minutes = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

async function crewed(
  app: App,
  alice: User,
  name: string,
  visibility: "public" | "private" = "private",
): Promise<{ repo: Repo; atlas: User; mason: User }> {
  const made = await createRepo(app, alice, { name, visibility });
  if (!made.ok) throw new Error(String(made.error));
  for (const agent of ["atlas", "mason"]) {
    if (getUserByName(app.db, agent) === undefined) {
      const created = await createAgent(app, alice, { username: agent });
      if (!created.ok) throw new Error(String(created.error));
    }
    expect(addToCrew(app, alice, made.value, agent).ok).toBe(true);
  }
  setCrewRole(app.db, made.value.id, getUserByName(app.db, "atlas")!.id, "planner");
  const set = await updateRepoSettings(app, alice, made.value, {
    autonomy: "autonomous",
    autonomyDirection: "Keep the engine small.",
    autonomyCeilingUsd: 100,
    autonomySlots: 1,
    autonomyBy: alice.id,
  });
  if (!set.ok) throw new Error(JSON.stringify(set.error));
  return {
    repo: getRepoById(app.db, made.value.id)!,
    atlas: getUserByName(app.db, "atlas")!,
    mason: getUserByName(app.db, "mason")!,
  };
}

describe("the tick says why each ready issue cannot start", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let servers: Servers;

  /** A finished agent run on `issue`, `ago` minutes back. */
  function ran(repo: Repo, issue: Issue, by: User, summary: string, ago = 0, state: "ok" | "failed" = "failed"): void {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.id,
      actorId: by.id,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state, summary, costUsd: 0.1 });
    const at = minutes(ago);
    app.db
      .query("UPDATE run SET created_at = ?2, started_at = ?2, finished_at = ?2 WHERE id = ?1")
      .run(run.id, at);
  }

  function issue(repo: Repo, title: string, body = ""): Issue {
    const opened = openIssue(app, alice, getRepoById(app.db, repo.id)!, { title, body });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-held-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    servers = await serve(app);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an issue held by each filter is counted under its name", async () => {
    const { repo, atlas, mason } = await crewed(app, alice, "engine");
    const free = issue(repo, "Free to start");

    const running = issue(repo, "Running");
    createRun(app.db, { repoId: repo.id, kind: "agent", issueId: running.id, actorId: mason.id, reason: "assigned" });

    const proposed = issue(repo, "Proposed");
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/proposed",
      base: "main",
      message: "Proposed",
      files: [{ path: "proposed.ts", content: "export const n = 1;\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const pull = await openPull(app, alice, repo, {
      title: "Proposed",
      body: `Closes #${proposed.number}`,
      baseBranch: "main",
      headBranch: "feature/proposed",
    });
    if (!pull.ok) throw new Error(String(pull.error));

    const planned = issue(repo, "The planner's");
    expect(assignIssue(app, alice, repo, planned, atlas).ok).toBe(true);

    const stuck = issue(repo, "Stalled");
    ran(repo, stuck, mason, "declined: the ask is unclear");

    const capped = issue(repo, "Capped");
    for (let n = 0; n < ISSUE_RUN_CAP; n++) ran(repo, capped, mason, `opened pull #${90 + n}`, 60 - n, "ok");

    const parked = issue(repo, "Parked twice");
    addComment(app, mason, repo, parked, `${PARK_NOTE}first`);
    addComment(app, mason, repo, getIssueById(app.db, parked.id)!, `${PARK_NOTE}second`);

    const quoting = issue(repo, "Quotes the red test", "fails: the widget renders");
    const fix = issue(repo, "Fix main");
    const check = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      env: repo.defaultBranch,
      commitOid: "a".repeat(40),
      reason: "push",
    });
    claimRun(app.db, check.id);
    finishRun(app.db, check.id, {
      state: "failed",
      summary: "check failed: 1 test failed",
      checkDetail: { passed: 1, failed: 1, names: ["the widget renders"] },
    });
    app.db
      .query("INSERT INTO sentinel_finding (key, issue_id, evidence, first_seen, last_seen) VALUES (?1, ?2, '', 'x', 'x')")
      .run(`degraded:${keyPart(`red:${repo.id}`)}`, fix.id);

    const finding = issue(repo, "A setting's finding");
    app.db
      .query("INSERT INTO sentinel_finding (key, issue_id, evidence, first_seen, last_seen) VALUES ('setting:x', ?1, '', 'x', 'x')")
      .run(finding.id);

    const held = heldNow(app, getRepoById(app.db, repo.id)!);
    const named = (h: keyof typeof held.by) => held.by[h].map((i) => i.number);
    expect(held.startable.map((r) => r.issue.number).sort()).toEqual([free.number, fix.number].sort());
    expect(named("running")).toEqual([running.number]);
    expect(named("open_pull")).toEqual([proposed.number]);
    expect(named("planner")).toEqual([planned.number]);
    expect(named("stalled")).toEqual([stuck.number]);
    expect(named("run_cap")).toEqual([capped.number]);
    expect(named("parked_twice")).toEqual([parked.number]);
    expect(named("red_fix")).toEqual([quoting.number]);
    expect(named("setting")).toEqual([finding.number]);
    expect(heldCounts(held).open_pull).toBe(1);
    expect(heldWords(held)).toBe(
      "running=1 open_pull=1 planner=1 stalled=1 run_cap=1 parked_twice=1 red_fix=1 setting=1",
    );
    // Something can start: the planner is not told the crew is stuck.
    expect(stuckOf(held)).toBeUndefined();
  });

  test("nothing startable with a slot free asks the planner once, with the breakdown, whatever the plate", async () => {
    const { repo, atlas, mason } = await crewed(app, alice, "stuck");
    const fresh = () => getRepoById(app.db, repo.id)!;
    // The map ran dry: the planner's first pass, an hour ago.
    expect(await driveRepo(app, fresh())).toBe("planned");
    const direction = getIssueById(app.db, fresh().directionIssueId!)!;
    ran(fresh(), direction, atlas, "opened #2", 60, "ok");
    expect(assignIssue(app, alice, fresh(), getIssueById(app.db, direction.id)!, null).ok).toBe(true);
    // Then five issues, each stalled by a builder since: more than the
    // plate holds (slots × 3), and nothing a builder may start.
    const stalled = ["One", "Two", "Three", "Four"].map((t) => issue(fresh(), t));
    for (const s of stalled) ran(fresh(), s, mason, "declined: too big", 40);
    const capped = issue(fresh(), "Five");
    for (let n = 0; n < ISSUE_RUN_CAP; n++) ran(fresh(), capped, mason, `opened pull #${90 + n}`, 45 - n, "ok");
    const held = heldNow(app, fresh());
    expect(held.startable).toHaveLength(0);
    expect(heldWords(held)).toBe("stalled=4 run_cap=1");

    expect(await driveRepo(app, fresh())).toBe("planned");
    expect(getIssueById(app.db, direction.id)!.assigneeId).toBe(atlas.id);

    // The pass the crew would start, given the breakdown in its brief.
    const told = stuckOf(heldNow(app, fresh()));
    expect(told?.held).toBe("stalled=4 run_cap=1");
    const brief = taskPrompt({
      agent: getAgentByName(app.db, "atlas")!,
      repo: fresh(),
      issue: getIssueById(app.db, direction.id)!,
      branch: "atlas/1-direction",
      forgeUrl: "http://forge.test",
      isApp: false,
      resuming: false,
      role: "planner",
      reason: "assigned",
      comments: [],
      reviews: [],
      reviewComments: [],
      since: direction.createdAt,
      stuck: told,
    });
    expect(brief).toContain("What holds them: stalled=4 run_cap=1.");
    expect(brief).toContain(`- #${stalled[0]!.number} One (stalled: a builder left it without a pull)`);
    expect(brief).toContain(`- #${capped.number} Five (at its run cap for the day)`);
    expect(brief).toContain("do not wait for a person's comment");
    // A builder is never told.
    expect(taskPrompt({ ...{
      agent: getAgentByName(app.db, "mason")!,
      repo: fresh(),
      issue: stalled[0]!,
      branch: "mason/1-one",
      forgeUrl: "http://forge.test",
      isApp: false,
      resuming: false,
      role: "builder",
      reason: "assigned",
      comments: [],
      reviews: [],
      reviewComments: [],
      since: direction.createdAt,
    }, stuck: told })).not.toContain("What holds them");

    // That pass ran and left them as they were: it is not asked again for
    // the same breakdown, and the full plate holds it as before.
    ran(fresh(), direction, atlas, "left them", 30, "ok");
    expect(assignIssue(app, alice, fresh(), getIssueById(app.db, direction.id)!, null).ok).toBe(true);
    expect(await driveRepo(app, fresh())).toBe("idle");
    expect(getIssueById(app.db, direction.id)!.assigneeId).toBeNull();
  });

  test("both doors: /flow and the terminal's Flow dialog show the counts, private ones to the owner only", async () => {
    const open = await crewed(app, alice, "open-door", "public");
    const shut = await crewed(app, alice, "shut-door");
    for (const { repo, mason } of [open, shut]) {
      ran(repo, issue(repo, "Stalled"), mason, "declined: too big", 10);
      const capped = issue(repo, "Capped");
      for (let n = 0; n < ISSUE_RUN_CAP; n++) ran(repo, capped, mason, `opened pull #${90 + n}`, 20 - n, "ok");
    }
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const res = await fetch(`${servers.url}/flow`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('id="held"');
    const row = page.slice(page.indexOf('data-held-repo="alice/open-door"'));
    expect(row).toContain('class="held-bar"');
    expect(row).toContain('<span class="mono">startable=0</span>');
    expect(row).toContain('<span class="mono">stalled=1</span>');
    expect(row).toContain('<span class="mono">run_cap=1</span>');
    expect(page).toContain('data-held-repo="alice/shut-door"');

    // The terminal reads the same rows: the owner sees both, an agent
    // reader the public one alone.
    const owner = flowLines(app.db, new Date(), [], undefined, readHeld(app, true)).join("\n");
    expect(owner).toContain("Ready, and why it waits:");
    expect(owner).toContain("alice/open-door startable=0 stalled=1 run_cap=1");
    expect(owner).toContain("alice/shut-door startable=0 stalled=1 run_cap=1");
    const agent = flowLines(app.db, new Date(), [], { queues: [] }, readHeld(app, false)).join("\n");
    expect(agent).toContain("alice/open-door startable=0 stalled=1 run_cap=1");
    expect(agent).not.toContain("shut-door");
    expect(heldLines([], 58)).toEqual(["Ready, and why it waits: no repository runs on its own."]);
  });

  test("the rows are kept a few seconds, then read afresh", async () => {
    const { repo, mason } = await crewed(app, alice, "kept");
    const t0 = Date.now() + 60 * 60_000;
    const stalled = (now: number) =>
      readHeld(app, true, now).find((r) => r.repo === "alice/kept")!.counts.stalled;
    expect(stalled(t0)).toBe(0);
    ran(repo, issue(repo, "Stalled"), mason, "declined: too big", 5);
    expect(stalled(t0 + 1_000)).toBe(0);
    expect(stalled(t0 + HELD_TTL_MS)).toBe(1);
  });
});
