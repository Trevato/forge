/** A team's page lists the open pulls waiting on its review, oldest first (#10162). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { nameTeams } from "../src/actions/issue_teams.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { NAMING_TEAM, OPEN_PULLS_OLDEST_FIRST, pullsWaitingOn, QUEUE_MAX } from "../src/core/team_queue.ts";
import { saveTeam } from "../src/core/teams.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { readTeamQueue } from "../src/actions/teams.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { quietLogs } from "./helpers/globals.ts";
import { expectWork } from "./helpers/work.ts";
import { statements } from "./helpers/statements.ts";
import { seatAs } from "./helpers/seat.ts";

quietLogs();

describe("pulls waiting on a team", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers | undefined;
  let alice: User;
  let repo: Repo;
  let n = 0;
  const id = (name: string) => getUserByName(app.db, name)!.id;

  const pullNaming = async (title: string, teams: string[]) => {
    const issue = openIssue(app, alice, repo, { title: "A chart" });
    if (!issue.ok) throw new Error(issue.error);
    const set = nameTeams(app, alice, repo, issue.value, teams);
    if (!set.ok) throw new Error(set.error);
    const branch = `h${++n}`;
    const c = await commitToBranch(app, alice, repo, {
      branch, base: "main", message: branch, files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const o = await openPull(app, alice, repo, {
      title, body: `Closes #${issue.value.number}`, baseBranch: "main", headBranch: branch,
    });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };

  const person = async (username: string) => {
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase",
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };

  // Each test gets its own forge: nothing is carried from the one before.
  beforeEach(async () => {
    n = 0;
    servers = undefined;
    dataDir = await mkdtemp(join(tmpdir(), "forge-team-queue-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const r = await createRepo(app, alice, { name: "garden", visibility: "private" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "seed", files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const agent = await createAgent(app, alice, { username: "quill" });
    if (!agent.ok) throw new Error(String(agent.error));
    addToCrew(app, alice, repo, "quill");
    seatAs(app.db, repo.id, id("quill"), "reviewer");
    saveTeam(app.db, "design", { charter: "", dial: 0, members: [id("quill")] });
    saveTeam(app.db, "security", { charter: "", dial: 0, members: [] });
  }, 120_000);

  afterEach(async () => {
    await servers?.stop();
    for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done));
    await Bun.sleep(100);
    app?.close();
    if (dataDir !== "") await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }, 30_000);

  test("lists held pulls oldest first, drops approved ones, hides what the viewer may not read", async () => {
    const first = await pullNaming("<b>First</b>", ["design"]);
    const second = await pullNaming("Second", ["design"]);
    const cleared = await pullNaming("Cleared", ["design"]);
    submitReview(app.db, { issueId: cleared.id, authorId: id("quill"), state: "approved", commitOid: cleared.headOid });
    await pullNaming("Elsewhere", ["security"]);
    expect(pullsWaitingOn(app.db, "design", alice).map((p) => p.title)).toEqual(["<b>First</b>", "Second"]);
    expect(pullsWaitingOn(app.db, "design", alice)[0]).toMatchObject({ owner: "alice", repo: "garden", number: first.number });
    expect(second.number).toBeGreaterThan(first.number);
    // The repository is private: a stranger and a signed-out viewer see none of it.
    expect(pullsWaitingOn(app.db, "design", await person("bob"))).toEqual([]);
    expect(pullsWaitingOn(app.db, "design", undefined)).toEqual([]);
  });

  test("the web page escapes the title, links the pull and says so when a team has nothing", async () => {
    const first = await pullNaming("<b>First</b>", ["design"]);
    servers = await serve(app);
    const res = await fetch(`${servers.url}/settings/teams`, {
      headers: { cookie: `forge_session=${createSession(app.db, alice.id).token}` },
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("Waiting on this team");
    expect(body).toContain("&lt;b&gt;First&lt;/b&gt;");
    expect(body).not.toContain("<b>First</b>");
    expect(body).toContain(`/alice/garden/pulls/${first.number}`);
    expect(body).toContain("Nothing is waiting on this team.");
    expect(body).not.toContain("<h3>Waiting on this team");
  });

  test("the terminal reads through the page's gate: an admin lists, anyone else is refused", async () => {
    await pullNaming("Terminal pull", ["design"]);
    expect(readTeamQueue(app, alice, "design")).toMatchObject({ ok: true });
    expect(readTeamQueue(app, await person("bob"), "design")).toMatchObject({ ok: false });
    expect(readTeamQueue(app, undefined, "design")).toMatchObject({ ok: false });
    expect(readTeamQueue(app, alice, "nope")).toEqual({ ok: false, error: "not_found" });

    const open = async (username: string) => {
      const terminal = headlessTerminal(140, 32);
      const { app: tui } = createForgeApp(
        app,
        { sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(app.db, username)! },
        { terminal, exitHooks: false },
      );
      tui.start();
      const key = async (k: string, ctrl = false) => {
        tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
        await settleApp(tui);
      };
      await key("k", true);
      for (const ch of "Crew teams") await key(ch);
      await key("enter");
      await key("w");
      const text = tui.screen.toText();
      tui.stop();
      return text;
    };
    const seen = await open("alice");
    expect(seen).toContain("Terminal pull");
    expect(seen).toContain("garden#");
    expect((await open("bob")).includes("Terminal pull")).toBe(false);
  });

  test("200 open pulls: at most 50 listed, with bounded work, walking an index", async () => {
    await pullNaming("First", ["design"]);
    const db = app.db;
    const src = db.query<Record<string, unknown>, []>("SELECT * FROM issue WHERE title = 'First'").get()!;
    const pullRow = db.query<Record<string, unknown>, [string]>("SELECT * FROM pull WHERE issue_id = ?1").get(src.id as string)!;
    const insert = (table: string, row: Record<string, unknown>) =>
      db.query(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`)
        .run(...(Object.values(row) as never[]));
    db.transaction(() => {
      for (let i = 0; i < 200; i++) {
        const nid = `bulk-${i}`;
        insert("issue", { ...src, id: nid, number: 1000 + i, created_at: `2030-01-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z` });
        insert("pull", { ...pullRow, issue_id: nid });
      }
    })();
    // Work, not a clock (a stopwatch is a coin flip in a loaded check cell; see test/helpers/work.ts):
    // statements run, bounded by the pulls walked — a handful of reads each, no N+1 beyond that.
    const cost = (slug: string) => statements(db, async () => void pullsWaitingOn(db, slug, alice));
    expect(pullsWaitingOn(db, "design", alice).length).toBe(QUEUE_MAX);
    expectWork(await cost("design"), { max: 20 * QUEUE_MAX });
    // A team holding nothing never walks the open pulls at all.
    expect(pullsWaitingOn(db, "security", alice)).toEqual([]);
    expectWork(await cost("security"), { max: 5 });
    const plan = db.query(`EXPLAIN QUERY PLAN ${OPEN_PULLS_OLDEST_FIRST}`).all().map((r) => (r as { detail: string }).detail);
    expect(plan.join("\n")).toContain("issue_open_pull_age");
    for (const line of plan) expect(line).not.toContain("TEMP B-TREE");
    const naming = db.query(`EXPLAIN QUERY PLAN ${NAMING_TEAM}`).all("x").map((r) => (r as { detail: string }).detail);
    expect(naming.join("\n")).toContain("issue_team_slug");
  });
});
