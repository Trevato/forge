/**
 * Why each ready issue cannot start (#2244): an issue held by each filter
 * is counted under that filter's name, the tick's words say the counts,
 * and a crew with free slots and nothing startable asks the planner once,
 * with the breakdown — a full plate does not hold it. /flow and the
 * terminal's Flow dialog show the same counts, private repositories to the
 * owner only. Each test makes its own repository and crew.
 */
import { quietWeek } from "./helpers/week-quiet.ts";
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addComment, assignIssue, openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { getAgentByName } from "../src/core/agents.ts";
import { getIssueById, listIssues, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { DONE_NOTE } from "../src/core/done_on_main.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { driveRepo } from "../src/crew/autonomy.ts";
import { taskPrompt } from "../src/crew/brief.ts";
import { ISSUE_RUN_CAP } from "../src/crew/guard.ts";
import { heldCounts, heldNow, heldWords, replannable, stuckOf } from "../src/crew/held.ts";
import { PARK_NOTE } from "../src/crew/parks.ts";
import { hunt, keyPart } from "../src/crew/sentinel.ts";
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
  seatAs(app.db, made.value.id, getUserByName(app.db, "atlas")!.id, "planner");
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
    quietWeek(app.db);
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

    const done = issue(repo, "Done already");
    addComment(app, mason, repo, done, `${DONE_NOTE}${"b".repeat(40)}`);

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

    app.db.run("UPDATE repo SET plans_need_nod = 0, decisions_by = 'decider' WHERE id = ?1", [repo.id]);
    const held = heldNow(app, getRepoById(app.db, repo.id)!);
    const named = (h: keyof typeof held.by) => held.by[h].map((i) => i.number);
    expect(held.startable.map((r) => r.issue.number).sort()).toEqual([free.number, fix.number, parked.number].sort());
    expect(named("running")).toEqual([running.number]);
    expect(named("open_pull")).toEqual([proposed.number]);
    expect(named("planner")).toEqual([planned.number]);
    expect(named("done_on_main")).toEqual([done.number]);
    expect(named("stalled")).toEqual([stuck.number]);
    expect(named("run_cap")).toEqual([capped.number]);
    expect(named("parked_twice")).toEqual([]); // on go the builders retry it
    expect(named("red_fix")).toEqual([quoting.number]);
    expect(heldCounts(held).open_pull).toBe(1);
    expect(heldWords(held)).toBe(
      "running=1 open_pull=1 planner=1 done_on_main=1 stalled=1 run_cap=1 red_fix=1",
    );
    app.db.run("UPDATE repo SET plans_need_nod = 1, decisions_by = 'me' WHERE id = ?1", [repo.id]);
    expect(heldNow(app, getRepoById(app.db, repo.id)!).by.parked_twice.map((i) => i.number)).toEqual([parked.number]);
    // Something can start: the planner is not told the crew is stuck.
    expect(stuckOf(held)).toBeUndefined();
  });

  test("an issue whose pull opened in the last 10 minutes is held, so the next one starts (#8473)", async () => {
    const { repo, mason } = await crewed(app, alice, "settle");
    const first = issue(repo, "First in line");
    const second = issue(repo, "Second in line");
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# settle\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const headBranch = `mason/${first.number}-first`;
    const branch = await commitToBranch(app, alice, repo, {
      branch: headBranch,
      base: "main",
      message: "First",
      files: [{ path: "first.ts", content: "export const n = 1;\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    // The pull names no issue, so only the branch ties it to the first.
    const pull = await openPull(app, mason, repo, { title: "First", body: "Done.", baseBranch: "main", headBranch });
    if (!pull.ok) throw new Error(String(pull.error));

    const held = heldNow(app, getRepoById(app.db, repo.id)!);
    expect(held.by.open_pull.map((i) => i.number)).toEqual([first.number]);
    expect(held.startable.map((r) => r.issue.number)).toEqual([second.number]);
    expect(heldWords(held)).toBe("open_pull=1");
  });

  test("one tick starts a run per free slot, and a held issue never takes one (#8729)", async () => {
    const { repo: made, mason } = await crewed(app, alice, "slots");
    for (const name of ["mason2", "mason3"]) {
      const created = await createAgent(app, alice, { username: name });
      if (!created.ok) throw new Error(String(created.error));
      expect(addToCrew(app, alice, getRepoById(app.db, made.id)!, name).ok).toBe(true);
    }
    const set = await updateRepoSettings(app, alice, getRepoById(app.db, made.id)!, { autonomySlots: 3 });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    const repo = getRepoById(app.db, made.id)!;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# slots\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const held = issue(repo, "Alpha rounding of corners");
    const rest = [
      issue(repo, "Bravo caching of thumbnails"),
      issue(repo, "Charlie escaping of titles"),
      issue(repo, "Delta printing of receipts"),
    ];
    // The first has a pull opened a moment ago, so the dispatcher would refuse it.
    const headBranch = `mason/${held.number}-alpha`;
    const branch = await commitToBranch(app, alice, repo, {
      branch: headBranch,
      base: "main",
      message: "Alpha",
      files: [{ path: "alpha.ts", content: "export const n = 1;\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const pull = await openPull(app, mason, repo, { title: "Alpha", body: "Done.", baseBranch: "main", headBranch });
    if (!pull.ok) throw new Error(String(pull.error));

    expect(await driveRepo(app, getRepoById(app.db, repo.id)!)).toBe("picked");
    // Assigning is the event that starts a run: exactly the three startable issues are assigned.
    const taken = [held, ...rest].filter((i) => getIssueById(app.db, i.id)!.assigneeId !== null).map((i) => i.id);
    expect(taken.sort()).toEqual(rest.map((i) => i.id).sort());
    expect(heldWords(heldNow(app, getRepoById(app.db, repo.id)!))).toContain("open_pull=1");
  });

  test("a sentinel finding is a builder's to start on the next tick, never parked on the sentinel (#3002)", async () => {
    const { repo, mason } = await crewed(app, alice, "watched");
    const fresh = () => getRepoById(app.db, repo.id)!;
    const made = await createAgent(app, alice, { username: "sentinel" });
    if (!made.ok) throw new Error(String(made.error));
    expect(addToCrew(app, alice, fresh(), "sentinel").ok).toBe(true);
    const sentinel = getUserByName(app.db, "sentinel")!;
    seatAs(app.db, repo.id, sentinel.id, "reviewer");

    // A lane past its budget: the sentinel files it at once, unassigned.
    const now = Date.now();
    const span = app.db
      .query<{ id: number }, [number]>(
        "INSERT INTO degraded_span (cause, sentence, href, opened_at) VALUES ('stuck:held-test', 'One lane is past its budget.', '/x', ?1) RETURNING id",
      )
      .get(now - 2 * 60_000)!;
    try {
      hunt(app, `alice/${repo.name}`, now);
    } finally {
      app.db.query("UPDATE degraded_span SET closed_at = ?2 WHERE id = ?1").run(span.id, now);
    }
    const filed = listIssues(app.db, repo.id, { state: "open" } as never).filter((i) => i.title.startsWith("Sentinel: "));
    const finding = filed.find((i) => i.title.includes("stuck:held-test"))!;
    expect(finding).toBeDefined();
    expect(finding.assigneeId).toBeNull();
    // Only the finding is left to start, so the tick's pick is it.
    for (const other of filed) if (other.id !== finding.id) app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(other.id);
    expect(heldNow(app, fresh()).startable.map((r) => r.issue.number)).toContain(finding.number);

    // One parked on the sentinel as it used to be: the tick frees it, and a builder starts it.
    expect(assignIssue(app, alice, fresh(), finding, sentinel).ok).toBe(true);
    expect(heldNow(app, fresh()).by.planner.map((i) => i.number)).toEqual([finding.number]);
    expect(await driveRepo(app, fresh())).toBe("picked");
    expect(getIssueById(app.db, finding.id)!.assigneeId).toBe(mason.id);
  });

  test("a planner or a reviewer with a run in flight keeps its issue", async () => {
    const { repo, atlas } = await crewed(app, alice, "in-flight");
    const fresh = () => getRepoById(app.db, repo.id)!;
    const held = issue(fresh(), "The planner's, running");
    expect(assignIssue(app, alice, fresh(), held, atlas).ok).toBe(true);
    createRun(app.db, { repoId: repo.id, kind: "agent", issueId: held.id, actorId: atlas.id, reason: "assigned" });
    await driveRepo(app, fresh());
    expect(getIssueById(app.db, held.id)!.assigneeId).toBe(atlas.id);
  });

  test("an issue found done on main is held as done_on_main, never re-planned, until the crew parks it", async () => {
    const { repo, mason } = await crewed(app, alice, "closing");
    const fresh = () => getRepoById(app.db, repo.id)!;
    const done = issue(fresh(), "Already shipped");
    addComment(app, mason, fresh(), done, `${DONE_NOTE}${"c".repeat(40)}`);
    const held = heldNow(app, fresh());
    expect(held.by.done_on_main.map((i) => i.number)).toEqual([done.number]);
    expect(held.by.stalled).toHaveLength(0);
    expect(replannable(held)).toHaveLength(0);
    expect(heldWords(held)).toBe("done_on_main=1");
    expect(stuckOf(held)).toBeUndefined();

    addComment(app, mason, fresh(), getIssueById(app.db, done.id)!, `${PARK_NOTE}not done after all`);
    // The builder that tried it since left without a pull: stalled, so the planner's.
    ran(fresh(), done, mason, "declined: it is not there", 0);
    const again = heldNow(app, fresh());
    expect(again.by.done_on_main).toHaveLength(0);
    expect(replannable(again).map((i) => i.number)).toEqual([done.number]);
  });

  test("an issue the crew found done on main is held as done_on_main, not replannable", async () => {
    const { repo, mason } = await crewed(app, alice, "finished");
    const oid = "a".repeat(40);
    const at = (id: string, ago: number) =>
      app.db.query("UPDATE comment SET created_at = ?2 WHERE id = ?1").run(id, minutes(ago));
    const say = (i: Issue, body: string, ago: number) => {
      const c = addComment(app, alice, getRepoById(app.db, repo.id)!, getIssueById(app.db, i.id)!, body);
      if (!c.ok) throw new Error(String(c.error));
      at(c.value.id, ago);
    };
    const done = issue(repo, "Already done");
    ran(repo, done, mason, "declined: it is done", 30);
    say(done, `${DONE_NOTE}${oid}`, 20);
    const reparked = issue(repo, "Done, then parked");
    ran(repo, reparked, mason, "declined: it is done", 30);
    say(reparked, `${DONE_NOTE}${oid}`, 20);
    say(reparked, `${PARK_NOTE}not so`, 10);
    ran(repo, reparked, mason, "declined: it is not done", 5);
    const spoken = issue(repo, "Done, then a word");
    ran(repo, spoken, mason, "declined: it is done", 30);
    say(spoken, `${DONE_NOTE}${oid}`, 20);
    say(spoken, "Please try again", 10);

    const held = heldNow(app, getRepoById(app.db, repo.id)!);
    const named = (h: keyof typeof held.by) => held.by[h].map((i) => i.number);
    expect(named("done_on_main")).toContain(done.number);
    expect(named("stalled")).not.toContain(done.number);
    expect(replannable(held).map((i) => i.number)).not.toContain(done.number);
    // A later park is a newer word: it is the planner's to re-plan again.
    expect(named("done_on_main")).not.toContain(reparked.number);
    expect(replannable(held).map((i) => i.number)).toContain(reparked.number);
    // A person's comment after the done note does not make it startable.
    expect(held.startable.map((r) => r.issue.number)).not.toContain(spoken.number);
    expect(named("done_on_main")).toContain(spoken.number);
    expect(heldWords(held)).toContain("done_on_main=");
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

  test("three doors: /boards, /flow and the terminal's Flow dialog show the counts, private ones to the owner only", async () => {
    const open = await crewed(app, alice, "open-door", "public");
    const shut = await crewed(app, alice, "shut-door");
    for (const { repo, mason } of [open, shut]) {
      ran(repo, issue(repo, "Stalled"), mason, "declined: too big", 10);
      if (repo === open.repo) {
        addComment(app, mason, repo, issue(repo, "Shipped"), `${DONE_NOTE}${"d".repeat(40)}`);
      }
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
    const res = await fetch(`${servers.url}/boards`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('id="held"');
    const at = page.indexOf('data-held-repo="alice/open-door"');
    const row = page.slice(at, page.indexOf("</tr>", at));
    expect(row).toContain('<meter');
    expect(row).toContain('aria-label="0 of 3 ready can start"');
    expect(row).toContain('data-tone="attn"');
    expect(row).toContain('<span class="num">0</span> startable</span>');
    expect(row).toContain('<span class="num">1</span> stalled</span>');
    expect(row).toContain('<span class="num">1</span> done on main</span>');
    expect(row).toContain('data-held="done_on_main"');
    expect(page).not.toContain("held-done_on_main");
    expect(row).toContain('<span class="num">1</span> run cap</span>');
    expect(page).toContain('data-held-repo="alice/shut-door"');

    // /boards is the owner's: the same counts, private ones included, and a
    // stranger is not shown the page at all.
    const boards = await (await fetch(`${servers.url}/boards`, { headers: { cookie } })).text();
    expect(boards).toContain('id="held"');
    expect(boards).toContain('id="pipeline"');
    expect(boards).toContain('data-held-repo="alice/open-door"');
    expect(boards).toContain('data-held-repo="alice/shut-door"');
    expect(boards).toContain('<span class="num">1</span> run cap</span>');
    // Signed out, a signed-in non-admin and an agent token all get the
    // not-found page: none sees the rows or the pipeline.
    const bob = await createUser(app.db, {
      origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase",
    });
    if (!bob.ok) throw new Error(bob.error);
    const made = await createAgent(app, alice, { username: "scout-reader" });
    if (!made.ok) throw new Error(String(made.error));
    const bobIn = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username: "bob", password: "a-good-passphrase" }),
    });
    const bobCookie = (bobIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const agentToken = createToken(app.db, made.value.user.id, "t", "rw").token;
    for (const headers of [{}, { cookie: bobCookie }, { authorization: `Bearer ${agentToken}` }]) {
      const seen = await fetch(`${servers.url}/boards`, { headers, redirect: "manual" });
      const text = await seen.text();
      expect(text).not.toContain("data-held-repo");
      expect(text).not.toContain('id="held"');
      expect(text).not.toContain('id="pipeline"');
      expect(text).not.toContain("alice/shut-door");
    }

    // The terminal reads the same rows: the owner sees both, an agent
    // reader the public one alone.
    const owner = flowLines(app.db, new Date(), [], undefined, readHeld(app, true)).join("\n");
    expect(owner).toContain("Ready, and why it waits:");
    expect(owner).toContain("alice/open-door startable=0 done_on_main=1 stalled=1");
    expect(owner).toContain("alice/shut-door startable=0 stalled=1 run_cap=1");
    const agent = flowLines(app.db, new Date(), [], { queues: [] }, readHeld(app, false)).join("\n");
    expect(agent).toContain("alice/open-door startable=0 done_on_main=1 stalled=1");
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
