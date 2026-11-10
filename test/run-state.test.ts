/**
 * A crew run's state is worked out from what it did (#8707): one function over
 * its activity names it waiting, working, needs input, failed, done or silent;
 * a silent run and a repeating issue each raise one alarm, the repeat stops;
 * a plan checklist is replaced whole on the issue; the runs tab counts what the
 * pipeline counts; and the runs API filters by `state`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { setPlan } from "../src/actions/run_plan.ts";
import { getAgent, type Agent } from "../src/core/agents.ts";
import { getIssuePlan } from "../src/core/issue_plans.ts";
import { getIssueById, listComments, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun, getRun, runningCount, type Run } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { queueAgentRun } from "../src/crew/dispatch.ts";
import { REPEAT_NOTE, repeatTripped } from "../src/crew/repeat.ts";
import { firedAlarms } from "../src/flow/alarms.ts";
import { readPipeline } from "../src/flow/pipeline.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { noteActivity } from "../src/runs/activity.ts";
import { runState, SILENT_MS, shownState } from "../src/runs/state.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let mallory: User;
let bot: Agent;
let repo: Repo;
let made = 0;

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const fresh = (): Repo => getRepoById(app.db, repo.id)!;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function held(title: string): Issue {
  const issue = ok(openIssue(app, alice, fresh(), { title: `${title} ${++made}` }));
  app.db.query("UPDATE issue SET assignee_id = ?1 WHERE id = ?2").run(bot.user.id, issue.id);
  return getIssueById(app.db, issue.id)!;
}

/** An agent run of the bot on `issue`, left in `state`, started `startedAgo` ms ago. */
function runOn(issue: Issue, state: "queued" | "running" | "ok" | "failed", startedAgo = 0): Run {
  const run = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: issue.id, actorId: bot.user.id, reason: "assigned" });
  if (state !== "queued") claimRun(app.db, run.id);
  if (state === "ok" || state === "failed") finishRun(app.db, run.id, { state, summary: "x", costUsd: 0 });
  if (startedAgo > 0)
    app.db.query("UPDATE run SET started_at = ?1, created_at = ?1 WHERE id = ?2").run(ago(startedAgo), run.id);
  return getRun(app.db, run.id)!;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-run-state-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  alice = ok(await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true }));
  mallory = ok(await createUser(app.db, { origin: "seed", trusted: true, username: "mallory", email: "mallory@forge.local", password: "a-good-passphrase" }));
  ok(await createAgent(app, alice, { username: "bot" }));
  repo = ok(await createRepo(app, alice, { name: "square", visibility: "public" }));
  ok(await updateRepoSettings(app, alice, repo, { autonomy: "assisted", autonomyDirection: "keep the square", autonomyBy: alice.id }));
  expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
  bot = getAgent(app.db, getUserByName(app.db, "bot")!.id)!;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("one function names a run's state from what it did", () => {
  const now = new Date();
  test("waiting: queued, not started", () => {
    expect(runState(runOn(held("a"), "queued"), { now })).toBe("waiting");
  });
  test("working: running and heard from", () => {
    expect(runState(runOn(held("b"), "running"), { now })).toBe("working");
  });
  test("needs input: its plan asks a person", () => {
    const issue = held("c");
    const run = runOn(issue, "running");
    ok(setPlan(app, bot.user, repo, issue, { items: [{ text: "pick a colour" }], ask: "Which colour?" }));
    expect(shownState(app.db, getRun(app.db, run.id)!)).toBe("needs input");
  });
  test("failed", () => {
    expect(runState(runOn(held("d"), "failed"), { now })).toBe("failed");
  });
  test("done", () => {
    expect(runState(runOn(held("e"), "ok"), { now })).toBe("done");
  });
  test("silent: running, nothing seen for the set time; any sign of life lifts it", () => {
    const run = runOn(held("f"), "running", SILENT_MS + 60_000);
    expect(runState(run, { now })).toBe("silent");
    noteActivity(run.id);
    expect(runState(run, { now })).toBe("working");
  });
});

describe("silence raises one alarm", () => {
  test("two silent runs are one alarm, naming the one silent longest; the shown state is on the API row", async () => {
    const older = runOn(held("g"), "running", 3 * SILENT_MS);
    runOn(held("h"), "running", 2 * SILENT_MS);
    const silent = firedAlarms(app.db, new Date(), { dataDir: null }).filter((a) => a.key === "silent");
    expect(silent).toHaveLength(1);
    expect(silent[0]!.href).toEndWith(`/runs/${older.id}`);
    const token = createToken(app.db, alice.id, "t", "ro").token;
    const res = await fetch(`${servers.url}/api/v1/repos/alice/square/runs?state=running`, { headers: { authorization: `Bearer ${token}` } });
    const rows = ((await res.json()) as { items?: { id: string; shown: string }[] }).items ?? [];
    expect(rows.find((r) => r.id === older.id)?.shown).toBe("silent");
  });
});

describe("the same issue repeating runs is stopped", () => {
  test("the 2026-11-02 sequence: runs that each succeeded without a pull, in minutes, trip it once", () => {
    const issue = held("Empty pulls");
    for (let n = 0; n < 3; n++) runOn(issue, "ok");
    expect(repeatTripped(app.db, fresh(), issue.id)).toBe(false);
    runOn(issue, "ok");
    expect(repeatTripped(app.db, fresh(), issue.id)).toBe(true);
    // The next start is refused, the issue parked once, and one alarm stands.
    expect(queueAgentRun(app, fresh(), issue, bot, "assigned", alice.id)).toBeUndefined();
    expect(queueAgentRun(app, fresh(), issue, bot, "assigned", alice.id)).toBeUndefined();
    expect(listComments(app.db, issue.id).filter((c) => c.body === REPEAT_NOTE)).toHaveLength(1);
    expect(getIssueById(app.db, issue.id)!.assigneeId).toBeNull();
    expect(firedAlarms(app.db, new Date(), { dataDir: null }).filter((a) => a.key === "repeat")).toHaveLength(1);
  });
  test("runs spread beyond ten minutes do not trip it; a reader's word does not lift it, a writer's does", async () => {
    const slow = held("Slow");
    for (let n = 0; n < 5; n++) {
      const run = runOn(slow, "ok");
      app.db.query("UPDATE run SET created_at = ?1 WHERE id = ?2").run(ago((n + 1) * 5 * 60_000), run.id);
    }
    expect(repeatTripped(app.db, fresh(), slow.id)).toBe(false);
    const issue = held("Loop");
    for (let n = 0; n < 4; n++) runOn(issue, "ok");
    await Bun.sleep(5);
    ok(addComment(app, mallory, repo, issue, "Go on."));
    expect(repeatTripped(app.db, fresh(), issue.id)).toBe(true);
    ok(addComment(app, alice, repo, issue, "Try the other way."));
    expect(repeatTripped(app.db, fresh(), issue.id)).toBe(false);
  });
});

describe("a plan is replaced whole on its issue", () => {
  test("the second update leaves only itself; a stranger may not set it; a bad shape is refused", () => {
    const issue = held("Plan me");
    const run = runOn(issue, "running");
    ok(setPlan(app, bot.user, repo, issue, { items: [{ text: "read" }, { text: "write" }] }));
    expect(getIssuePlan(app.db, issue.id)!.runId).toBe(run.id);
    ok(setPlan(app, bot.user, repo, issue, { items: [{ text: "read", done: true }] }));
    expect(getIssuePlan(app.db, issue.id)!.items).toEqual([{ text: "read", done: true }]);
    expect(setPlan(app, mallory, repo, issue, { items: [] })).toEqual({ ok: false, error: "forbidden" });
    expect(setPlan(app, bot.user, repo, issue, { items: "nope" })).toEqual({ ok: false, error: "invalid" });
    expect(setPlan(app, bot.user, repo, issue, { items: Array.from({ length: 13 }, () => ({ text: "x" })) })).toEqual({ ok: false, error: "invalid" });
  });
  test("only the agent with a run going on the issue keeps its plan: a writer, or a run on another issue, is refused", () => {
    const issue = held("Not yours");
    runOn(held("Elsewhere"), "running");
    expect(setPlan(app, bot.user, repo, issue, { items: [{ text: "x" }] })).toEqual({ ok: false, error: "forbidden" });
    expect(setPlan(app, alice, repo, issue, { items: [{ text: "x" }] })).toEqual({ ok: false, error: "forbidden" });
    expect(getIssuePlan(app.db, issue.id)).toBeUndefined();
    runOn(issue, "ok");
    expect(setPlan(app, bot.user, repo, issue, { items: [{ text: "x" }] })).toEqual({ ok: false, error: "forbidden" });
  });
  test("it is set over the API and read on the issue and its page", async () => {
    const issue = held("Plan over HTTP");
    runOn(issue, "running");
    const token = createToken(app.db, bot.user.id, "t", "rw").token;
    const url = `${servers.url}/api/v1/repos/alice/square/issues/${issue.number}/plan`;
    const put = await fetch(url, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ items: [{ text: "<b>one</b>", done: true }, { text: "two" }] }) });
    expect(put.status).toBe(200);
    const read = (await (await fetch(`${servers.url}/api/v1/repos/alice/square/issues/${issue.number}`, { headers: { authorization: `Bearer ${token}` } })).json()) as { plan: { items: unknown[] } };
    expect(read.plan.items).toHaveLength(2);
    const bad = await fetch(url, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ items: [{ done: true }] }) });
    expect(bad.status).toBe(422);
    const html = await (await fetch(`${servers.url}/alice/square/issues/${issue.number}`, { headers: { authorization: `Bearer ${token}` } })).text();
    expect(html).toContain("1 of 2 done");
    expect(html).not.toContain("<b>one</b>");
  });
});

describe("the runs tab counts what is really running", () => {
  test("running agent runs and checks, as the pipeline counts them; queued, paused and finished are not", () => {
    createRun(app.db, { repoId: repo.id, kind: "agent", reason: "assigned" });
    const check = createRun(app.db, { repoId: repo.id, kind: "check", reason: "push" });
    claimRun(app.db, check.id);
    const deploy = createRun(app.db, { repoId: repo.id, kind: "deploy", env: "production" });
    claimRun(app.db, deploy.id);
    const stages = readPipeline(app.db);
    const piped = stages.filter((s) => ["building", "review", "checking"].includes(s.key)).reduce((n, s) => n + s.active, 0);
    expect(runningCount(app.db, repo.id)).toBe(piped);
    expect(piped).toBeGreaterThan(0);
  });
});

describe("the new reads walk an index", () => {
  const plan = (sql: string, ...args: string[]) =>
    app.db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => (r as { detail: string }).detail);
  test("the running count, the silent scan and the repeat count", () => {
    const lines = [
      ...plan("SELECT COUNT(*) FROM run WHERE state = 'running' AND repo_id = ?1 AND kind IN ('agent','check')", "r"),
      ...plan("SELECT x.id FROM run x WHERE x.state = 'running' AND x.kind = 'agent'"),
      ...plan("SELECT created_at FROM run WHERE issue_id = ?1 AND kind = 'agent' AND created_at > ?2 ORDER BY created_at LIMIT 4", "i", "t"),
    ];
    for (const line of lines) {
      expect(line).not.toMatch(/^SCAN (?!.*USING (COVERING )?INDEX)/);
    }
  });
});

describe("the runs API filters by state", () => {
  test("state=failed lists only failed runs; an unknown state is refused, not ignored", async () => {
    runOn(held("broken"), "failed");
    const token = createToken(app.db, alice.id, "t", "ro").token;
    const get = (q: string) => fetch(`${servers.url}/api/v1/repos/alice/square/runs${q}`, { headers: { authorization: `Bearer ${token}` } });
    const failed = ((await (await get("?state=failed")).json()) as { items: { state: string }[] }).items;
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((r) => r.state === "failed")).toBe(true);
    expect((await get("?state=sideways")).status).toBe(422);
  });
});

describe("the terminal shows the plan and the state the page does", () => {
  test("rows, title and the state worth leading with", async () => {
    const { planLines, planTitle, headline } = await import("../src/tui/screens/runplan.ts");
    const issue = held("Terminal");
    const run = runOn(issue, "running");
    ok(setPlan(app, bot.user, repo, issue, { items: [{ text: "read", done: true }, { text: "write" }], ask: "Which colour?" }));
    const plan = getIssuePlan(app.db, issue.id)!;
    expect(planLines(plan)).toEqual(["[x] read", "[ ] write", "needs input: Which colour?"]);
    const { shownStates } = await import("../src/runs/state.ts");
    const shown = shownStates(app.db, [getRun(app.db, run.id)!]).get(run.id);
    expect(shown).toBe("needs input");
    expect(planTitle(plan, shown)).toBe("Plan · 1 of 2 done · needs input");
    expect(headline(["working", "silent", "done"])).toBe("silent");
    expect(planLines(undefined)).toEqual([]);
  });
});
