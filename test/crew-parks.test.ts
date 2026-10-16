/**
 * An interrupted run is not a park. A builder's run the provider's limit, an
 * unreachable API or a restart ended writes no park note and is no strike;
 * strikes count only since a person's last word, and the map's `parked` is
 * the same rule that stops dispatch.
 *
 * And struck out is not forgotten: the second park says every reason on the
 * issue and hands it to the planner, whose next pass is given the list —
 * once, even with a full map, even after it declined the direction — while
 * the board, the map's data and the MCP's `map` show it until it is split,
 * replaced or deferred.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import {
  addComment,
  openIssue,
  setIssueState,
} from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { getAgentByName, setCrewRole } from "../src/core/agents.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { getIssueById, listComments, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import {
  claimRun,
  createRun,
  finishRun,
  listRuns,
} from "../src/core/runs.ts";
import { migrations } from "../src/core/schema.ts";
import { submitReview } from "../src/core/reviews.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { handedOverPulls } from "../src/crew/guard.ts";
import { driveRepo, parkedCount, settleAgentRun } from "../src/crew/autonomy.ts";
import { taskPrompt } from "../src/crew/brief.ts";
import { breakerTripped } from "../src/crew/breaker.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import {
  interruptedSummary,
  interruptionOf,
} from "../src/crew/interrupted.ts";
import { laterGate } from "../src/crew/later.ts";
import {
  alreadyDoneOids,
  alreadyDoneSummary,
  namedCommits,
  onBase,
} from "../src/crew/already.ts";
import { repoDir } from "../src/git/repos.ts";
import { alreadyDone } from "../src/core/done_on_main.ts";
import { askedIn, askedJson } from "../src/core/asked.ts";
import {
  handedOverAt,
  parkedTwice,
  parkReason,
  struckOut,
} from "../src/crew/parks.ts";

/**
 * One forge with alice's `engine` on its own: atlas plans, mason builds.
 * `ended` is a builder's run on an issue that ends without a pull, settled
 * as the crew would settle it.
 */
async function engine(
  prefix: string,
  visibility: "public" | "private" = "private",
) {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  const app = createApp({ dataDir, port: 0 });
  const servers = await serve(app);
  const a = await createUser(app.db, {
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  const alice = a.value;
  const made = await createRepo(app, alice, { name: "engine", visibility });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  for (const name of ["atlas", "mason"]) {
    const agent = await createAgent(app, alice, { username: name });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, repo, name).ok).toBe(true);
  }
  const atlas = getUserByName(app.db, "atlas")!;
  const mason = getUserByName(app.db, "mason")!;
  setCrewRole(app.db, repo.id, atlas.id, "planner");
  const set = await updateRepoSettings(app, alice, repo, {
    autonomy: "autonomous",
    autonomyDirection: "Keep the engine small.",
    autonomyCeilingUsd: 100,
    autonomyBy: alice.id,
  });
  if (!set.ok) throw new Error(JSON.stringify(set.error));
  const fresh = () => getRepoById(app.db, repo.id)!;
  return {
    dataDir,
    app,
    servers,
    alice,
    atlas,
    mason,
    repo,
    fresh,
    issue(title: string): Issue {
      const opened = openIssue(app, alice, fresh(), { title });
      if (!opened.ok) throw new Error(String(opened.error));
      return opened.value;
    },
    ended(on: Issue, summary: string): boolean {
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
    },
    async close(): Promise<void> {
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
type Engine = Awaited<ReturnType<typeof engine>>;
const tick = () => Bun.sleep(5);

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
  let e: Engine;
  let app: App;
  let servers: Servers;
  let alice: User;
  let atlas: User;
  let mason: User;
  let repo: Repo;
  const fresh = () => e.fresh();
  const issue = (title: string): Issue => e.issue(title);
  const ended = (on: Issue, summary: string): boolean => e.ended(on, summary);
  const parks = (on: Issue) =>
    listComments(app.db, on.id).filter((c) =>
      c.body.startsWith("Parked by the crew"),
    );

  beforeAll(async () => {
    e = await engine("forge-parks-");
    ({ app, servers, alice, atlas, mason, repo } = e);
  });

  afterAll(() => e.close());

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
    expect(breakerTripped(app.db, fresh(), work.id)).toBe(false);
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

  test("a person's word counts again from zero; a builder's and the planner's do not", async () => {
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
    // Nor is the planner's word alone: it answers by splitting, replacing
    // or deferring the issue, and a comment leaves it as it was.
    addComment(
      app,
      atlas,
      fresh(),
      getIssueById(app.db, work.id)!,
      "Looked at it; fine as written.",
    );
    await tick();
    expect(parkedCount(app, fresh(), work.id)).toBe(2);
    expect(struckOut(app.db, fresh(), [work.id]).has(work.id)).toBe(true);
    addComment(
      app,
      alice,
      fresh(),
      getIssueById(app.db, work.id)!,
      "Try the fixed step.",
    );
    await tick();
    expect(parkedCount(app, fresh(), work.id)).toBe(0);
    expect(struckOut(app.db, fresh(), [work.id]).has(work.id)).toBe(false);
    ended(work, "nothing to propose");
    await tick();
    expect(parkedCount(app, fresh(), work.id)).toBe(1);
  });
});

describe("a comment that only reads like a park", () => {
  let e: Engine;
  beforeAll(async () => {
    // Public: anyone signed in may comment here, and writes nothing.
    e = await engine("forge-park-words-", "public");
  }, 30_000);
  afterAll(() => e.close());

  test("refused: a reader's comment in a park's words strikes nothing, and hands nothing to the planner", async () => {
    const { app, atlas } = e;
    const c = await createUser(app.db, {
      trusted: true,
      username: "carol",
      email: "carol@forge.local",
      password: "a-good-passphrase",
    });
    if (!c.ok) throw new Error(c.error);
    const work = e.issue("Shader cache");
    const current = () => getIssueById(app.db, work.id)!;
    for (let n = 0; n < 3; n++) {
      const said = addComment(
        app,
        c.value,
        e.fresh(),
        current(),
        "Parked by the crew: the run ended without a pull: nothing to propose",
      );
      expect(said.ok).toBe(true);
      await tick();
    }
    expect(parkedCount(app, e.fresh(), work.id)).toBe(0);
    expect(struckOut(app.db, e.fresh(), [work.id]).has(work.id)).toBe(false);
    expect(handedOverAt(app.db, e.fresh(), work.id)).toBeUndefined();
    expect(parkedTwice(app.db, [e.fresh()])).toEqual([]);
    // So the planner has no more say over it than over any other issue.
    const part = e.issue("Shader cache: the key only");
    const closed = setIssueState(app, atlas, e.fresh(), current(), "closed", {
      reason: "split",
      into: [part.number],
    });
    expect(closed.ok ? "closed" : closed.error).toBe("forbidden");
    expect(current().state).toBe("open");
    // A person's own issue stays theirs to close and reopen, writer or not.
    const hers = openIssue(app, c.value, e.fresh(), { title: "A reader's idea" });
    if (!hers.ok) throw new Error(String(hers.error));
    for (const to of ["closed", "open"] as const)
      expect(
        setIssueState(
          app,
          c.value,
          e.fresh(),
          getIssueById(app.db, hers.value.id)!,
          to,
        ).ok,
      ).toBe(true);
    // The crew's own first park is the first strike, not the fourth.
    expect(e.ended(work, "nothing to propose")).toBe(true);
    await tick();
    expect(parkedCount(app, e.fresh(), work.id)).toBe(1);
    expect(struckOut(app.db, e.fresh(), [work.id]).has(work.id)).toBe(false);
  });
});

describe("an issue parked twice is the planner's", () => {
  let e: Engine;
  let app: App;
  let atlas: User;
  let mason: User;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let base: string;
  let work: Issue;
  let again: Issue;
  /** An issue older than `again`'s hand-over, and the Later gate. */
  let older: Issue;
  let gate: Issue;
  /** bob's own app, and the issue on it that was parked twice. */
  let tool: Repo;
  let hinge: Issue;
  const cookies: Record<string, string> = {};
  const declined =
    "the run ended without a pull: no changes pushed: DECLINED: out of scope";
  const nothing = "the run ended without a pull: nothing to propose";
  const fresh = () => e.fresh();
  const listed = () => parkedTwice(app.db, [fresh()]).map((i) => i.number);
  const current = (issue: Issue) => getIssueById(app.db, issue.id)!;
  const direction = () => getIssueById(app.db, e.fresh().directionIssueId!)!;
  const hours = (n: number) => new Date(Date.now() + n * 3_600_000);
  /** A planning run on the direction that ends, settled as the crew would. */
  const pass = (state: "ok" | "failed", summary: string): void => {
    const on = direction();
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: on.id,
      actorId: atlas.id,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state, summary });
    settleAgentRun(app, e.fresh(), {
      issueId: on.id,
      state,
      summary,
      reason: "assigned",
      actorId: atlas.id,
    });
  };
  const signIn = async (name: string): Promise<string> =>
    (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: name,
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  const board = async (who: string): Promise<string> =>
    (
      await fetch(`${base}/board`, { headers: { cookie: cookies[who]! } })
    ).text();

  beforeAll(async () => {
    e = await engine("forge-parked-twice-");
    ({ app, alice, atlas, mason, repo } = e);
    base = e.servers.url;
    // The board shows apps: the engine is one.
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const record = insertApp(app.db, {
      repoId: repo.id,
      slug: "engine",
      access: "private",
    });
    if (!record.ok) throw new Error(record.error);
    const b = await createUser(app.db, {
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    for (const name of ["alice", "bob"]) cookies[name] = await signIn(name);
  }, 30_000);

  afterAll(() => e.close());

  test("the second park says every reason on the issue, in the one note, and hands it over", async () => {
    work = e.issue("Scene graph");
    expect(e.ended(work, "no changes pushed: DECLINED: out of scope")).toBe(
      true,
    );
    await tick();
    expect(listComments(app.db, work.id).at(-1)!.body).toBe(
      `Parked by the crew: ${declined}`,
    );
    expect(listed()).toEqual([]);
    expect(e.ended(work, "nothing to propose")).toBe(true);
    await tick();
    const second = listComments(app.db, work.id).at(-1)!.body;
    expect(second).toStartWith(`Parked by the crew: ${nothing}\n`);
    expect(second).toContain("it is the planner's now");
    expect(second).toContain(`1. ${declined}`);
    expect(second).toContain(`2. ${nothing}`);
    // One note: still two strikes, and its reason reads back as that alone.
    expect(parkedCount(app, fresh(), work.id)).toBe(2);
    expect(parkReason(second)).toBe(nothing);
    expect(current(work).assigneeId).toBeNull();
    expect(parkedTwice(app.db, [fresh()])).toMatchObject([
      {
        number: work.number,
        title: "Scene graph",
        reasons: [declined, nothing],
      },
    ]);
  });

  test("a closed pull's park reads back as its reason, without the word to the planner", () => {
    expect(
      parkReason(
        "Parked by the crew: the check stayed red through 3 automatic tries (pull #15 closed). Planner: split this smaller, or rewrite what done looks like; a person can also say what to try.",
      ),
    ).toBe("the check stayed red through 3 automatic tries (pull #15 closed)");
  });

  test("the planner's next pass is owed it once: with a full map, and after it declined", async () => {
    // A dry map asks the planner, as it always did.
    expect(await driveRepo(app, e.fresh())).toBe("planned");
    expect(direction().assigneeId).toBe(atlas.id);
    pass("failed", "declined: nothing to add to the direction");
    expect(direction().assigneeId).toBeNull();
    await tick();
    const more = ["Culling", "Lights", "Shadows", "Decals", "Particles"].map(
      (title) => e.issue(title),
    );
    // What it was already given does not ask again, and a full map asks nobody.
    expect(await driveRepo(app, e.fresh(), hours(1))).toBe("picked");
    expect(direction().assigneeId).toBeNull();
    // A second issue is parked twice, after that pass.
    older = more[0]!;
    again = more[4]!;
    e.ended(again, "nothing to propose");
    await tick();
    e.ended(again, "nothing to propose");
    await tick();
    expect(listed()).toEqual([work.number, again.number]);
    // Owed one pass: asked although four issues are ready, and although the
    // planner declined the direction and no person has spoken.
    expect(await driveRepo(app, e.fresh(), hours(1))).toBe("picked");
    expect(direction().assigneeId).toBe(atlas.id);
    // The pass leaves both as they were: it is not asked for them again…
    pass("ok", "no changes pushed: nothing changed");
    expect(await driveRepo(app, e.fresh(), hours(3))).toBe("picked");
    expect(direction().assigneeId).toBeNull();
    // …and they are not forgotten, and never dispatched.
    expect(listed()).toEqual([work.number, again.number]);
    expect(current(work).assigneeId).toBeNull();
    expect(current(again).assigneeId).toBeNull();
  });

  test("the planner's brief lists each one with every reason and the states it may leave it in", () => {
    const planner = getAgentByName(app.db, "atlas")!;
    const told = (
      extra: Partial<Parameters<typeof taskPrompt>[0]> = {},
    ): string =>
      taskPrompt({
        agent: planner,
        repo: e.fresh(),
        issue: direction(),
        branch: "atlas/1-direction",
        forgeUrl: base,
        isApp: false,
        resuming: false,
        role: "planner",
        reason: "assigned",
        comments: [],
        reviews: [],
        reviewComments: [],
        since: direction().createdAt,
        parkedTwice: parkedTwice(app.db, [fresh()]),
        laterGate: laterGate(app.db, repo.id),
        ...extra,
      });
    const brief = told();
    expect(brief).toContain(
      `- Parked twice: #${work.number} Scene graph (a person's ask)`,
    );
    expect(brief).toContain(`    1. ${declined}`);
    expect(brief).toContain(`    2. ${nothing}`);
    expect(brief).toContain(`- Parked twice: #${again.number} Particles`);
    expect(brief).toContain('{"state":"closed","reason":"split","into":[A,B]}');
    expect(brief).toContain('comment "replaced by #M"');
    // Dropping is for what the crew wrote; a person's ask is never dropped.
    expect(brief).toContain("- Dropped: only an issue the crew wrote");
    expect(brief).toContain("A person's ask is never yours to drop");
    expect(
      told({
        parkedTwice: [
          { number: 7, title: "Pool", reasons: ["a", "b"], byAgent: true },
        ],
      }),
    ).toContain("- Parked twice: #7 Pool (the crew's own)");
    // No Later gate here yet: nothing to defer behind.
    expect(brief).not.toContain("Later gate");
    expect(told({ laterGate: 9 })).toContain(
      `/issues/N/dependencies with {"blockedBy":9}`,
    );
    // A resumed session is told the same, as the news it is.
    const resumed = told({ resuming: true });
    expect(resumed).toContain(`- Parked twice: #${work.number} Scene graph`);
    expect(resumed).not.toContain("not captured in words");
    // A spent pull reads as a pull, and adds the pull-only instruction.
    const pulled = told({
      parkedTwice: [{ number: 9, title: "Spent", reasons: ["a"], byAgent: true, pull: true }],
    });
    expect(pulled).toContain("- Three reviews asked for changes, pull #9 Spent (the crew's own)");
    expect(pulled).toContain("A pull above is not closed by splitting an issue");
    expect(brief).not.toContain("A pull above is not closed");
    // A builder is never told; a planner handed nothing reads as before.
    expect(told({ role: "builder" })).not.toContain("Parked twice");
    expect(told({ parkedTwice: [] })).not.toContain("Parked twice");
  });

  test("the board lists it with its reasons for whoever owns the app, linked to the issue", async () => {
    const mine = await board("alice");
    expect(mine).toContain('id="declined"');
    expect(mine).toMatch(
      new RegExp(
        `the crew parked #${work.number} twice and\\s+handed it to the planner —\\s+Scene graph\\.`,
      ),
    );
    expect(mine).toContain(`<q>${declined}</q> <q>${nothing}</q>`);
    expect(mine).toContain(
      `<a class="btn" href="/alice/engine/issues/${work.number}">Open</a>`,
    );
    expect(mine).toContain(`href="/alice/engine/issues/${again.number}"`);
    // Nobody else is told: bob cannot see the engine.
    const theirs = await board("bob");
    expect(theirs).not.toContain('id="declined"');
    expect(theirs).not.toContain("parked #");
    // An owner who is no admin gets the line, escaped, and no word on the forge.
    const made = await createRepo(app, bob, {
      name: "tool",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    tool = made.value;
    const record = insertApp(app.db, {
      repoId: tool.id,
      slug: "tool",
      access: "private",
    });
    if (!record.ok) throw new Error(record.error);
    const stuck = openIssue(app, bob, tool, { title: "A <b>hinge</b>" });
    if (!stuck.ok) throw new Error(String(stuck.error));
    hinge = stuck.value;
    for (const why of [
      "the check stayed red.",
      "main moved under it <twice>",
    ]) {
      addComment(app, bob, tool, hinge, `Parked by the crew: ${why}`);
      await tick();
    }
    const own = await board("bob");
    expect(own).toContain(`href="/bob/tool/issues/${hinge.number}"`);
    expect(own).toContain("A &lt;b&gt;hinge&lt;/b&gt;.");
    expect(own).toContain(
      "<q>the check stayed red</q> <q>main moved under it &lt;twice&gt;</q>",
    );
    expect(own).not.toContain('id="forge"');
    expect(own).not.toContain("All fine");
    expect(own).not.toContain("/alice/engine/");
  });

  test("the map's data and the MCP's `map` list it with its reasons", async () => {
    const token = createToken(app.db, alice.id, "ro", "ro").token;
    const want = [
      {
        number: work.number,
        title: "Scene graph",
        reasons: [declined, nothing],
      },
      { number: again.number, title: "Particles", reasons: [nothing, nothing] },
    ];
    const data = (await (
      await fetch(`${base}/api/v1/repos/alice/engine/map`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { parkedTwice: unknown };
    expect(data.parkedTwice).toEqual(want);
    const answer = (await (
      await fetch(`${base}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "map", arguments: { app: "alice/engine" } },
        }),
      })
    ).json()) as { result: { content: { text: string }[] } };
    expect(JSON.parse(answer.result.content[0]!.text).parkedTwice).toEqual(
      want,
    );
  });

  test("it leaves the list when someone takes it up, and comes back when they let go", async () => {
    // A run in flight on it: someone is on it.
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: again.id,
      actorId: mason.id,
      reason: "assigned",
    });
    expect(listed()).toEqual([work.number]);
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, {
      state: "failed",
      summary: interruptedSummary("cancelled"),
    });
    expect(listed()).toEqual([work.number, again.number]);
    // An open pull that would close it is someone's answer already.
    const branch = await commitToBranch(app, alice, e.fresh(), {
      branch: "feature/particles",
      base: "main",
      message: "Particles",
      files: [{ path: "particles.ts", content: "export const n = 1;\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const proposed = await openPull(app, alice, e.fresh(), {
      title: "Particles",
      body: `Closes #${again.number}`,
      baseBranch: "main",
      headBranch: "feature/particles",
    });
    if (!proposed.ok) throw new Error(String(proposed.error));
    expect(listed()).toEqual([work.number]);
    const pull = getIssueById(app.db, proposed.value.id)!;
    expect(setIssueState(app, alice, e.fresh(), pull, "closed").ok).toBe(true);
    expect(listed()).toEqual([work.number, again.number]);
    // Nobody's word on the crew takes it off: not the builder's report, and
    // not the planner's answer when the issue is left as it was.
    addComment(app, mason, e.fresh(), current(again), "Tried twice.");
    addComment(app, atlas, e.fresh(), current(again), "Fine as written.");
    expect(listed()).toEqual([work.number, again.number]);
  });

  test("the planner may split what it was handed into fresh open issues, drop only what an agent wrote, and nothing else", async () => {
    const closing = (
      who: User,
      on: Issue,
      how?: { reason: "done" | "dropped" | "split"; into?: number[] },
    ) => {
      const closed = setIssueState(
        app,
        who,
        e.fresh(),
        current(on),
        "closed",
        how,
      );
      return closed.ok ? "closed" : closed.error;
    };
    const part = e.issue("Particles: emitters only");
    const untried = e.issue("Fog");
    const once = e.issue("Bloom");
    e.ended(once, "nothing to propose");
    await tick();
    gate = e.issue(
      "Later gate: nothing behind this starts until the owner opens it",
    );
    const gone = e.issue("Particles, the old plan");
    expect(setIssueState(app, alice, e.fresh(), gone, "closed").ok).toBe(true);
    // An issue the crew wrote itself, parked twice like the person's.
    const made = openIssue(app, mason, e.fresh(), {
      title: "Tidy the particle pool",
    });
    if (!made.ok) throw new Error(String(made.error));
    const own = made.value;
    for (let n = 0; n < 2; n++) {
      e.ended(own, "nothing to propose");
      await tick();
    }
    expect(struckOut(app.db, fresh(), [own.id]).has(own.id)).toBe(true);

    // Refused: a builder, on the very issue the planner was handed.
    expect(closing(mason, again, { reason: "dropped" })).toBe("forbidden");
    expect(
      closing(mason, again, { reason: "split", into: [part.number] }),
    ).toBe("forbidden");
    // Refused: the planner, on an issue nobody handed it.
    expect(closing(atlas, untried, { reason: "dropped" })).toBe("forbidden");
    expect(closing(atlas, once, { reason: "dropped" })).toBe("forbidden");
    expect(
      closing(atlas, untried, { reason: "split", into: [part.number] }),
    ).toBe("forbidden");
    // Refused: the planner calling what the crew gave up on done.
    expect(closing(atlas, again)).toBe("forbidden");
    expect(closing(atlas, again, { reason: "done" })).toBe("forbidden");
    // Refused: the planner dropping a person's ask. That is the person's call.
    expect(closing(atlas, again, { reason: "dropped" })).toBe("forbidden");
    // Refused: a split that names nothing to replace it.
    expect(closing(atlas, again, { reason: "split" })).toBe("forbidden");
    expect(closing(atlas, again, { reason: "split", into: [] })).toBe(
      "forbidden",
    );
    // Refused: a split into anything but a fresh, open replacement — a
    // closed issue (a drop under another name), an issue older than the
    // hand-over, the issue itself, the Later gate, or any of those beside a
    // good one.
    for (const into of [
      [gone.number],
      [older.number],
      [again.number],
      [gate.number],
      [part.number, gone.number],
      [part.number, 9999],
    ])
      expect(closing(atlas, again, { reason: "split", into })).toBe(
        "forbidden",
      );
    // Refused: a pull, however often it was parked.
    const branch = await commitToBranch(app, alice, e.fresh(), {
      branch: "feature/fog",
      base: "main",
      message: "Fog",
      files: [{ path: "fog.ts", content: "export const fog = 1;\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, e.fresh(), {
      title: "Fog",
      body: "A start.",
      baseBranch: "main",
      headBranch: "feature/fog",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = getIssueById(app.db, opened.value.id)!;
    for (const why of ["the check stayed red", "main moved under it"]) {
      addComment(app, alice, e.fresh(), pull, `Parked by the crew: ${why}`);
      await tick();
    }
    expect(struckOut(app.db, fresh(), [pull.id]).has(pull.id)).toBe(true);
    expect(closing(atlas, pull)).toBe("forbidden");
    expect(closing(atlas, pull, { reason: "dropped" })).toBe("forbidden");
    // Refused: someone else's forge-mate, who cannot see the repository at all.
    expect(closing(bob, again, { reason: "dropped" })).toBe("not_found");
    // Nothing above changed anything.
    for (const on of [again, untried, once, pull, own, part, older])
      expect(current(on).state).toBe("open");

    // Refused over the API too, as the planner's own token.
    const token = createToken(app.db, atlas.id, "rw", "rw").token;
    const patch = async (number: number, body: unknown): Promise<number> =>
      (
        await fetch(`${base}/api/v1/repos/alice/engine/issues/${number}`, {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        })
      ).status;
    const closed = { state: "closed" };
    expect(await patch(untried.number, { ...closed, reason: "dropped" })).toBe(
      403,
    );
    expect(await patch(again.number, closed)).toBe(403);
    expect(await patch(again.number, { ...closed, reason: "dropped" })).toBe(
      403,
    );
    expect(await patch(again.number, { ...closed, reason: "split" })).toBe(403);
    expect(
      await patch(again.number, {
        ...closed,
        reason: "split",
        into: [gone.number],
      }),
    ).toBe(403);
    expect(
      await patch(again.number, {
        ...closed,
        reason: "split",
        into: [gate.number],
      }),
    ).toBe(403);
    expect(current(again).state).toBe("open");

    // Allowed: dropping what an agent wrote.
    expect(await patch(own.number, { ...closed, reason: "dropped" })).toBe(200);
    expect(current(own).closeReason).toBe("dropped");
    // Allowed: a person's ask split into the fresh, open issue that replaces
    // it, by the route the brief names; the trail is on the closed issue.
    expect(
      await patch(again.number, {
        ...closed,
        reason: "split",
        into: [part.number],
      }),
    ).toBe(200);
    expect(current(again).state).toBe("closed");
    expect(current(again).closeReason).toBe("split");
    // What is closed stays closed: the grant is to close, never to reopen.
    const reopened = setIssueState(
      app,
      atlas,
      e.fresh(),
      current(again),
      "open",
    );
    expect(reopened.ok ? "open" : reopened.error).toBe("forbidden");
    // Put back as it was, for what follows.
    expect(
      setIssueState(app, alice, e.fresh(), current(again), "open").ok,
    ).toBe(true);
    expect(listed()).toEqual([work.number, again.number]);
  });

  test("refused: an agent's own issue is not its own to close or reopen — what the planner opened to replace a person's ask stays", async () => {
    // A person's ask, handed over; the planner opens what replaces it and
    // splits the ask into that, as it may.
    const ask = e.issue("Decals");
    for (let n = 0; n < 2; n++) {
      e.ended(ask, "nothing to propose");
      await tick();
    }
    const made = openIssue(app, atlas, e.fresh(), { title: "Decals: one layer" });
    if (!made.ok) throw new Error(String(made.error));
    const stand = made.value;
    const token = createToken(app.db, atlas.id, "rw", "rw").token;
    const patch = async (number: number, body: unknown): Promise<number> =>
      (
        await fetch(`${base}/api/v1/repos/alice/engine/issues/${number}`, {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        })
      ).status;
    expect(
      await patch(ask.number, {
        state: "closed",
        reason: "split",
        into: [stand.number],
      }),
    ).toBe(200);
    expect(current(ask).closeReason).toBe("split");
    const set = (
      who: User,
      on: Issue,
      state: "open" | "closed",
      how?: { reason: "done" | "dropped" },
    ) => {
      const done = setIssueState(app, who, e.fresh(), current(on), state, how);
      return done.ok ? state : done.error;
    };
    // The ask now lives in the issue the planner wrote. Writing it does not
    // make it the planner's to close, by any reason or by any door.
    expect(set(atlas, stand, "closed")).toBe("forbidden");
    expect(set(atlas, stand, "closed", { reason: "done" })).toBe("forbidden");
    expect(set(atlas, stand, "closed", { reason: "dropped" })).toBe(
      "forbidden",
    );
    expect(await patch(stand.number, { state: "closed" })).toBe(403);
    expect(
      await patch(stand.number, { state: "closed", reason: "dropped" }),
    ).toBe(403);
    expect(current(stand).state).toBe("open");
    // Nor to reopen, once a person has closed it.
    expect(set(alice, stand, "closed")).toBe("closed");
    expect(set(atlas, stand, "open")).toBe("forbidden");
    expect(await patch(stand.number, { state: "open" })).toBe(403);
    expect(current(stand).state).toBe("closed");
    expect(set(alice, stand, "open")).toBe("open");
    // A builder's own issue is the same: it closes when a pull for it lands.
    const filed = openIssue(app, mason, e.fresh(), { title: "Sort the decals" });
    if (!filed.ok) throw new Error(String(filed.error));
    expect(set(mason, filed.value, "closed")).toBe("forbidden");
    expect(set(alice, filed.value, "closed")).toBe("closed");
    expect(set(mason, filed.value, "open")).toBe("forbidden");
    expect(current(filed.value).state).toBe("closed");
    // Off the planner's list again, for what follows.
    expect(set(alice, stand, "closed")).toBe("closed");
  });

  test("refused: a person's ask split into the crew's issue is still the person's — parked twice, it is split again, never dropped", async () => {
    const token = createToken(app.db, atlas.id, "rw", "rw").token;
    const patch = async (number: number, body: unknown): Promise<number> =>
      (
        await fetch(`${base}/api/v1/repos/alice/engine/issues/${number}`, {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        })
      ).status;
    const handOver = async (on: Issue): Promise<void> => {
      for (let n = 0; n < 2; n++) {
        expect(e.ended(on, "nothing to propose")).toBe(true);
        await tick();
      }
      expect(struckOut(app.db, fresh(), [on.id]).has(on.id)).toBe(true);
    };
    const opens = (title: string): Issue => {
      const made = openIssue(app, atlas, e.fresh(), { title });
      if (!made.ok) throw new Error(String(made.error));
      return made.value;
    };
    // A person's ask, handed over, split by the planner into its own issue.
    const ask = e.issue("Shadows");
    await handOver(ask);
    const x = opens("Shadows: one pass");
    expect(
      await patch(ask.number, {
        state: "closed",
        reason: "split",
        into: [x.number],
      }),
    ).toBe(200);
    // The crew parks the replacement twice: it is the planner's again — and
    // still the person's ask, so the board and the brief say so.
    await handOver(x);
    expect(listed()).toContain(x.number);
    expect(
      parkedTwice(app.db, [fresh()]).find((i) => i.number === x.number)!.byAgent,
    ).toBe(false);
    // Refused: dropping it, by the action and by the planner's token.
    const dropped = setIssueState(app, atlas, e.fresh(), current(x), "closed", {
      reason: "dropped",
    });
    expect(dropped.ok ? "closed" : dropped.error).toBe("forbidden");
    expect(await patch(x.number, { state: "closed", reason: "dropped" })).toBe(
      403,
    );
    expect(current(x).state).toBe("open");
    // Allowed: splitting it again into a fresh issue; and that one, parked
    // twice in its turn, is still the person's: the chain is followed.
    const y = opens("Shadows: the one pass, smaller");
    expect(
      await patch(x.number, { state: "closed", reason: "split", into: [y.number] }),
    ).toBe(200);
    await handOver(y);
    expect(await patch(y.number, { state: "closed", reason: "dropped" })).toBe(
      403,
    );
    expect(current(y).state).toBe("open");
    // The crew's own issue, parked twice, is still the planner's to drop.
    const own = opens("Tidy the shadow pool");
    await handOver(own);
    expect(await patch(own.number, { state: "closed", reason: "dropped" })).toBe(
      200,
    );
    // Off the list, for what follows.
    expect(setIssueState(app, alice, e.fresh(), current(y), "closed").ok).toBe(true);
  });

  test("the planner may defer it behind the Later gate or replace it with a fresh issue, and then it is off the board", async () => {
    expect(laterGate(app.db, repo.id)).toBe(gate.number);
    // Deferred: it waits for the gate, as the planner's own link.
    expect(linkIssue(app, atlas, e.fresh(), current(again), gate).ok).toBe(
      true,
    );
    expect(listed()).toEqual([work.number]);
    // Replaced: a fresh issue, and the old one closed as split into it.
    const rewritten = e.issue("Scene graph: nodes and transforms only");
    addComment(
      app,
      atlas,
      e.fresh(),
      current(work),
      `replaced by #${rewritten.number}`,
    );
    expect(
      setIssueState(app, atlas, e.fresh(), current(work), "closed", {
        reason: "split",
        into: [rewritten.number],
      }).ok,
    ).toBe(true);
    expect(listed()).toEqual([]);
    expect(await board("alice")).not.toContain("/alice/engine/issues/");
    // A person's word is the other way off: bob says what to try on his.
    addComment(app, bob, tool, hinge, "Try a smaller hinge.");
    expect(await board("bob")).not.toContain('id="declined"');
    expect(await board("alice")).not.toContain('id="declined"');
    // The owner opens the gate: what waited is as it was, so it is the
    // planner's again.
    expect(
      setIssueState(app, alice, e.fresh(), current(gate), "closed").ok,
    ).toBe(true);
    expect(laterGate(app.db, repo.id)).toBeUndefined();
    expect(listed()).toEqual([again.number]);
  });
});

describe("the planner's run, with a stand-in Claude Code", () => {
  let e: Engine;
  let crew: CrewHandle;
  let promptFile: string;

  beforeAll(async () => {
    e = await engine("forge-parked-brief-");
    const seeded = await commitToBranch(e.app, e.alice, e.repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    promptFile = join(e.dataDir, "fake.prompt");
    // The stand-in: records what it was told, plans nothing, pushes nothing.
    const fake = join(e.dataDir, "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first; printf '%s\\n' "$first" > "${promptFile}"
echo '{"type":"system","subtype":"init","session_id":"fake-plan","model":"fake"}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Nothing to add.","total_cost_usd":0.01,"num_turns":1,"session_id":"fake-plan","terminal_reason":"completed"}'
`,
    );
    chmodSync(fake, 0o755);
    crew = await startCrew(e.app, {
      forgeUrl: e.servers.url,
      localUrl: e.servers.url,
      binary: fake,
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
    });
  }, 30_000);

  afterAll(async () => {
    await crew.stop();
    await e.close();
  });

  test("second park, next tick, and the planning run's task carries the issue and why", async () => {
    const work = e.issue("Scene graph");
    e.ended(work, "no changes pushed: DECLINED: out of scope");
    await tick();
    e.ended(work, "nothing to propose");
    await tick();
    expect(await driveRepo(e.app, e.fresh())).toBe("planned");
    const direction = e.fresh().directionIssueId!;
    const deadline = Date.now() + 30_000;
    const settled = () =>
      listRuns(e.app.db, e.repo.id, { kind: "agent" }).find(
        (r) =>
          r.issueId === direction &&
          (r.state === "ok" || r.state === "failed" || r.state === "cancelled"),
      );
    while (settled() === undefined && Date.now() < deadline)
      await Bun.sleep(100);
    expect(settled()?.actorId).toBe(e.atlas.id);
    expect(existsSync(promptFile)).toBe(true);
    const told = readFileSync(promptFile, "utf8");
    expect(told).toContain(`- Parked twice: #${work.number} Scene graph`);
    expect(told).toContain(
      "1. the run ended without a pull: no changes pushed: DECLINED: out of scope",
    );
    expect(told).toContain(
      "2. the run ended without a pull: nothing to propose",
    );
  }, 60_000);
});

describe("a pull whose review loop is spent is the planner's (#1655)", () => {
  let e: Engine;
  let crew: CrewHandle;
  let promptFile: string;

  beforeAll(async () => {
    e = await engine("forge-spent-pull-");
    const seeded = await commitToBranch(e.app, e.alice, e.repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    promptFile = join(e.dataDir, "fake.prompt");
    const fake = join(e.dataDir, "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first; printf '%s\\n' "$first" > "${promptFile}"
echo '{"type":"system","subtype":"init","session_id":"fake-plan","model":"fake"}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Nothing to add.","total_cost_usd":0.01,"num_turns":1,"session_id":"fake-plan","terminal_reason":"completed"}'
`,
    );
    chmodSync(fake, 0o755);
    crew = await startCrew(e.app, {
      forgeUrl: e.servers.url,
      localUrl: e.servers.url,
      binary: fake,
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
    });
  }, 30_000);

  afterAll(async () => {
    await crew.stop();
    await e.close();
  });

  test("the planner is asked for it and its brief says three reviews asked for changes", async () => {
    const agent = await createAgent(e.app, e.alice, { username: "sentinel" });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(e.app, e.alice, e.fresh(), "sentinel").ok).toBe(true);
    const sentinel = getUserByName(e.app.db, "sentinel")!;
    setCrewRole(e.app.db, e.repo.id, sentinel.id, "reviewer");
    const branch = await commitToBranch(e.app, e.alice, e.fresh(), {
      branch: "feature/spent",
      base: "main",
      message: "spent",
      files: [{ path: "spent.txt", content: "spent\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(e.app, e.alice, e.fresh(), {
      title: "Spent loop",
      baseBranch: "main",
      headBranch: "feature/spent",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    e.app.db.query("UPDATE issue SET author_id = ?2 WHERE id = ?1").run(pull.id, e.mason.id);
    for (const n of [1, 2, 3])
      submitReview(e.app.db, {
        issueId: pull.id,
        authorId: sentinel.id,
        state: "changes_requested",
        body: `Round ${n}`,
        commitOid: pull.headOid,
      });
    expect(handedOverPulls(e.app.db, e.fresh()).map((h) => h.number)).toEqual([pull.number]);
    expect(await driveRepo(e.app, e.fresh())).toBe("planned");
    const direction = e.fresh().directionIssueId!;
    const deadline = Date.now() + 30_000;
    const settled = () =>
      listRuns(e.app.db, e.repo.id, { kind: "agent" }).find(
        (r) => r.issueId === direction && ["ok", "failed", "cancelled"].includes(r.state),
      );
    while (settled() === undefined && Date.now() < deadline) await Bun.sleep(100);
    expect(existsSync(promptFile)).toBe(true);
    const told = readFileSync(promptFile, "utf8");
    expect(told).toContain(`Three reviews asked for changes, pull #${pull.number} Spent loop`);
    expect(told).toContain("Round 3");
    expect(told).toContain("A pull above is not closed by splitting an issue");
  }, 60_000);
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

describe("an issue found already done is the asker's to close, not a park", () => {
  let e: Engine;
  let oid: string;
  const settle = (on: Issue, state: "ok" | "failed", summary: string) =>
    settleAgentRun(e.app, e.fresh(), {
      issueId: on.id,
      state,
      summary,
      reason: "assigned",
      actorId: e.mason.id,
    });

  beforeAll(async () => {
    e = await engine("forge-already-");
    const seeded = await commitToBranch(e.app, e.alice, e.repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    oid = seeded.value.commitOid;
  });
  afterAll(() => e.close());

  test("only a named commit that is on the base counts", async () => {
    const dir = repoDir(e.app.reposRoot, e.repo.ownerName, e.repo.name);
    expect(namedCommits("already done on main in " + oid.slice(0, 9))).toEqual([
      oid.slice(0, 9),
    ]);
    expect(namedCommits("already done on main")).toEqual([]);
    expect(namedCommits("out of scope, see " + oid.slice(0, 9))).toEqual([]);
    expect(await onBase(dir, "main", [oid.slice(0, 9)])).toEqual([oid]);
    expect(await onBase(dir, "main", ["deadbeef"])).toEqual([]);
    expect(await onBase(dir, "nope", [oid.slice(0, 9)])).toEqual([]);
  });

  test("an already-done outcome is recorded, shown, and no strike", async () => {
    const work = e.issue("Already built");
    const summary = alreadyDoneSummary([oid]);
    expect(alreadyDoneOids(summary)).toEqual([oid]);
    for (let n = 0; n < 3; n++) {
      expect(settle(work, "ok", summary)).toBe(true);
      await tick();
    }
    const parks = listComments(e.app.db, work.id).filter((c) =>
      c.body.startsWith("Parked by the crew"),
    );
    expect(parks).toEqual([]);
    expect(parkedCount(e.app, e.fresh(), work.id)).toBe(0);
    expect(struckOut(e.app.db, e.fresh(), [work.id]).has(work.id)).toBe(false);
    expect(alreadyDone(e.app.db, [work.id]).get(work.id)).toEqual([oid]);
    expect(getIssueById(e.app.db, work.id)!.state).toBe("open");

    const signin = await fetch(`${e.servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({
        username: "alice",
        password: "a-good-passphrase",
      }),
      redirect: "manual",
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await (
      await fetch(`${e.servers.url}/alice/engine/issues/${work.number}`, {
        headers: { cookie },
      })
    ).text();
    expect(page).toContain("waiting for you to close it");
    expect(page).toContain(`/commit/${oid}`);

    const closed = await fetch(
      `${e.servers.url}/alice/engine/issues/${work.number}/state`,
      {
        method: "POST",
        headers: { cookie, origin: e.servers.url },
        body: new URLSearchParams({ state: "closed", reason: "done" }),
        redirect: "manual",
      },
    );
    expect(closed.status).toBeLessThan(400);
    expect(getIssueById(e.app.db, work.id)!.state).toBe("closed");
    expect(
      listComments(e.app.db, work.id).some((c) =>
        c.body.startsWith(`Closed: already done on main in [\`${oid.slice(0, 7)}\``),
      ),
    ).toBe(true);
  });

  test("the asked JSON carries the commits; closing through any door writes the note", async () => {
    const work = e.issue("Asked and already built");
    expect(settle(work, "ok", alreadyDoneSummary([oid]))).toBe(true);
    const row = askedIn(e.app.db, [e.fresh()], { show: "all" }).find(
      (a) => a.issue.id === work.id,
    )!;
    expect(askedJson(row).doneBy).toEqual([oid]);
    // Not the web form: the same close the terminal makes.
    expect(setIssueState(e.app, e.alice, e.fresh(), work, "closed").ok).toBe(true);
    const comments = listComments(e.app.db, work.id).filter((c) =>
      c.body.startsWith("Closed: already done on main in "),
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain(oid.slice(0, 7));
    // An issue with no note closes without one.
    const plain = e.issue("Closed plainly");
    expect(setIssueState(e.app, e.alice, e.fresh(), plain, "closed").ok).toBe(true);
    expect(
      listComments(e.app.db, plain.id).some((c) => c.body.startsWith("Closed:")),
    ).toBe(false);
  });

  test("the asked page says done on main, with the commits", async () => {
    const work = e.issue("Asked page");
    expect(settle(work, "ok", alreadyDoneSummary([oid]))).toBe(true);
    const signin = await fetch(`${e.servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({
        username: "alice",
        password: "a-good-passphrase",
      }),
      redirect: "manual",
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await (
      await fetch(`${e.servers.url}/asked`, { headers: { cookie } })
    ).text();
    expect(page).toContain("Done on main");
    expect(page).toContain(`on main in ${oid.slice(0, 7)}, waiting for you to close it`);
  });

  test("an issue parked twice and then found done leaves the planner's list", () => {
    const work = e.issue("Parked, then built");
    e.ended(work, "no changes pushed: DECLINED: out of scope");
    e.ended(work, "no changes pushed: DECLINED: out of scope");
    const listed = () =>
      parkedTwice(e.app.db, [e.fresh()]).some((p) => p.issueId === work.id);
    expect(listed()).toBe(true);
    expect(settle(work, "ok", alreadyDoneSummary([oid]))).toBe(true);
    expect(alreadyDone(e.app.db, [work.id]).get(work.id)).toEqual([oid]);
    expect(listed()).toBe(false);
  });

  test("another person's comment that reads like the note is that person's word", async () => {
    const carol = await createUser(e.app.db, {
      trusted: true,
      username: "carol",
      email: "carol@forge.local",
      password: "a-good-passphrase",
    });
    if (!carol.ok) throw new Error(carol.error);
    // Anyone who can read may direct the crew here, for this test only.
    e.app.db.run("UPDATE repo SET visibility = 'public', crew_outsiders = 1 WHERE id = ?1", [e.repo.id]);
    try {
      const work = e.issue("Words");
      e.ended(work, "no changes pushed: DECLINED: out of scope");
      expect(parkedCount(e.app, e.fresh(), work.id)).toBe(1);
      await tick();
      addComment(
        e.app,
        carol.value,
        e.fresh(),
        work,
        "Done on main already, waiting for you to close it: try again anyway",
      );
      expect(parkedCount(e.app, e.fresh(), work.id)).toBe(0);
      expect(alreadyDone(e.app.db, [work.id]).has(work.id)).toBe(false);
    } finally {
      e.app.db.run("UPDATE repo SET visibility = 'private', crew_outsiders = 0 WHERE id = ?1", [e.repo.id]);
    }
  });

  test("an ordinary decline, or a claim with no commit, still parks", () => {
    const work = e.issue("Out of scope");
    expect(settle(work, "ok", "no changes pushed: DECLINED: out of scope")).toBe(true);
    expect(parkedCount(e.app, e.fresh(), work.id)).toBe(1);
    expect(alreadyDone(e.app.db, [work.id]).has(work.id)).toBe(false);
    expect(alreadyDoneOids("no changes pushed: already done: " + oid)).toEqual([]);
  });
});
