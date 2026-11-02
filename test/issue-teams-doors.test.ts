/**
 * Cross-team work (#2681), every door: the API route's answers, the issue
 * page's Teams form, the pull page's verdicts, the MCP tool and the
 * terminal's `t` key all name teams through `nameTeams`; and a team nobody
 * on the crew can ask never stops the pull being reviewed.
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import {} from "../src/core/agents.ts";
import { listEvents } from "../src/core/events.ts";
import { teamsOfIssue, teamVerdicts } from "../src/core/issue_teams.ts";
import type { Issue } from "../src/core/issues.ts";
import type { Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { saveTeam } from "../src/core/teams.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { sendToReview } from "../src/crew/review.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { issueScreen } from "../src/tui/screens/issue.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { withScripts } from "./helpers/page-script.ts";

quietLogs();

describe("naming teams, at every door", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let n = 0;
  const id = (name: string) => getUserByName(app.db, name)!.id;
  const fresh = () => getRepoById(app.db, repo.id)!;
  const base = () => `${servers.url}/alice/garden`;
  const cookie = (u: User) => `forge_session=${createSession(app.db, u.id).token}`;

  const newIssue = (): Issue => {
    const o = openIssue(app, alice, repo, { title: "A chart" });
    if (!o.ok) throw new Error(o.error);
    return o.value;
  };
  const api = (u: User | undefined, method: string, path: string, body?: unknown, scope: "ro" | "rw" = "rw") =>
    fetch(`${servers.url}/api/v1/repos/alice/garden${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(u ? { authorization: `Bearer ${createToken(app.db, u.id, "t", scope).token}` } : {}),
      },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  const mcp = async (u: User, name: string, args: unknown, scope: "ro" | "rw" = "rw") => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${createToken(app.db, u.id, "t", scope).token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as any;
    const text = body.result?.content?.[0]?.text as string;
    try {
      return JSON.parse(text);
    } catch {
      return { error: text };
    }
  };
  const pullClosing = async (issue: Issue): Promise<Pull> => {
    const branch = `d${++n}`;
    const c = await commitToBranch(app, alice, repo, {
      branch,
      base: "main",
      message: branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const o = await openPull(app, alice, repo, {
      title: branch,
      body: `Closes #${issue.number}`,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!o.ok) throw new Error(String(o.error));
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: o.value.id,
      env: `pull-${o.value.number}`,
      commitOid: o.value.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "ok" });
    return { ...o.value, authorIsAgent: true };
  };
  const reviewRuns = (pull: Pull) =>
    listRuns(app.db, repo.id, { issueId: pull.id }).filter((r) => r.reason === "review");

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-issue-teams-doors-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const username of ["alice", "bob"]) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: username === "alice",
      });
      if (!made.ok) throw new Error(made.error);
      if (username === "alice") alice = made.value;
      else bob = made.value;
    }
    const r = await createRepo(app, alice, { name: "garden", visibility: "private" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const agent = await createAgent(app, alice, { username: "quill" });
    if (!agent.ok) throw new Error(String(agent.error));
    addToCrew(app, alice, repo, "quill");
    seatAs(app.db, repo.id, id("quill"), "reviewer");
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the API names, reads back, and refuses with its reasons", async () => {
    const issue = newIssue();
    const path = `/issues/${issue.number}/teams`;
    const put = await api(alice, "PUT", path, { teams: ["design", "data-science"] });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ teams: ["design", "data-science"] });
    expect(await (await api(alice, "GET", path)).json()).toEqual({ teams: ["design", "data-science"] });
    for (const bad of [{}, { teams: "design" }, { teams: [1] }, { teams: [null] }])
      expect((await api(alice, "PUT", path, bad)).status).toBe(400);
    expect((await api(alice, "PUT", path, "{nope")).status).toBe(400);
    const many = await api(alice, "PUT", path, { teams: ["design", "security", "platform"] });
    expect(many.status).toBe(422);
    expect(JSON.stringify(await many.json())).toContain("too_many");
    const none = await api(alice, "PUT", path, { teams: ["nope"] });
    expect(none.status).toBe(422);
    expect(JSON.stringify(await none.json())).toContain("no_such_team");
    // A refusal changes nothing.
    expect(teamsOfIssue(app.db, issue.id)).toEqual(["design", "data-science"]);
  });

  test("a read-only token cannot name teams; a stranger gets 404 on a private repo", async () => {
    const issue = newIssue();
    const path = `/issues/${issue.number}/teams`;
    expect((await api(alice, "PUT", path, { teams: ["design"] }, "ro")).status).toBe(403);
    expect(teamsOfIssue(app.db, issue.id)).toEqual([]);
    expect((await api(bob, "GET", path)).status).toBe(404);
    expect((await api(bob, "PUT", path, { teams: ["design"] })).status).toBe(404);
    expect((await api(undefined, "GET", path)).status).toBe(404);
    expect(teamsOfIssue(app.db, issue.id)).toEqual([]);
  });

  test("the issue page names teams through a form, same-origin only", async () => {
    const issue = newIssue();
    const page = await (await fetch(`${base()}/issues/${issue.number}`, { headers: { cookie: cookie(alice) } })).text();
    expect(page).toContain(`action="/alice/garden/issues/${issue.number}/teams"`);
    expect(page).toContain('name="teams" value="design"');
    const post = (origin: string, teams: string[]) => {
      const form = new URLSearchParams();
      for (const t of teams) form.append("teams", t);
      return fetch(`${base()}/issues/${issue.number}/teams`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie: cookie(alice), "content-type": "application/x-www-form-urlencoded", origin },
        body: form,
      });
    };
    expect((await post("http://evil.example", ["design"])).status).toBe(403);
    expect(teamsOfIssue(app.db, issue.id)).toEqual([]);
    expect((await post(servers.url, ["design", "platform"])).status).toBe(303);
    expect(teamsOfIssue(app.db, issue.id)).toEqual(["design", "platform"]);
    const three = await post(servers.url, ["design", "platform", "security"]);
    expect(three.status).toBe(303);
    expect(teamsOfIssue(app.db, issue.id)).toEqual(["design", "platform"]);
    const again = await (await fetch(`${base()}/issues/${issue.number}`, { headers: { cookie: cookie(alice) } })).text();
    expect(again).toMatch(/name="teams" value="design"\s+checked/);
    // A reader who cannot write sees no form.
    const bobsView = await fetch(`${base()}/issues/${issue.number}`, { headers: { cookie: cookie(bob) } });
    expect(bobsView.status).toBe(404);
  });

  test("the pull's own page and its files page both show each team's verdict, escaped", async () => {
    saveTeam(app.db, "design", { charter: "", dial: 0, members: [id("quill")] });
    const issue = newIssue();
    await api(alice, "PUT", `/issues/${issue.number}/teams`, { teams: ["design", "security"] });
    const pull = await pullClosing(issue);
    submitReview(app.db, { issueId: pull.id, authorId: id("quill"), state: "approved", commitOid: pull.headOid });
    for (const tail of ["", "/files"]) {
      const text = await (await fetch(`${base()}/pulls/${pull.number}${tail}`, { headers: { cookie: cookie(alice) } })).text();
      expect(text).toContain("Team reviews");
      expect(text).toMatch(/Design<\/strong>:\s*approved by quill/);
      expect(text).toMatch(/Security<\/strong>:\s*<span class="muted">awaiting a reviewer/);
    }
  });

  test("the MCP tool reads, names and refuses the same way", async () => {
    const issue = newIssue();
    const told = await mcp(alice, "issue_teams", { repo: "alice/garden", number: issue.number, teams: ["platform"] });
    expect(told.teams).toEqual(["platform"]);
    expect((await mcp(alice, "issue_teams", { repo: "alice/garden", number: issue.number })).teams).toEqual(["platform"]);
    const many = await mcp(alice, "issue_teams", { repo: "alice/garden", number: issue.number, teams: ["design", "security", "platform"] });
    expect(JSON.stringify(many)).toContain("at most 2");
    expect(JSON.stringify(await mcp(alice, "issue_teams", { repo: "alice/garden", number: issue.number, teams: "design" }))).toContain("list of team slugs");
    expect(teamsOfIssue(app.db, issue.id)).toEqual(["platform"]);
    expect(JSON.stringify(await mcp(bob, "issue_teams", { repo: "alice/garden", number: issue.number, teams: ["design"] }))).toContain("no such");
  });

  test("the terminal's t key names teams through the same action", async () => {
    const issue = newIssue();
    const terminal = headlessTerminal(140, 40);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user: alice },
      { terminal, exitHooks: false },
    );
    tui.start();
    const key = async (k: string) => {
      tui.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
      await settleApp(tui);
    };
    try {
      await settleApp(tui);
      tui.push(issueScreen(session, tui.ctx, local(session, fresh()), issue.number));
      await settleApp(tui);
      await key("t");
      expect(tui.screen.toText()).toContain("Teams (at most 2)");
      // Cursor on Design: toggle it and apply.
      await key(" ");
      await key("enter");
      expect(teamsOfIssue(app.db, issue.id)).toEqual(["design"]);
    } finally {
      tui.stop();
    }
  });

  test("an issue naming a team no crew reviewer is on still gets one review run", async () => {
    saveTeam(app.db, "platform", { charter: "", dial: 0, members: [] });
    const issue = newIssue();
    await api(alice, "PUT", `/issues/${issue.number}/teams`, { teams: ["platform"] });
    const pull = await pullClosing(issue);
    expect(await sendToReview(app, fresh(), pull)).toBe("sent");
    expect(reviewRuns(pull)).toHaveLength(1);
  });

  test("a team that cannot be asked waits for the hour, not the first sweep, while the other is asked", async () => {
    saveTeam(app.db, "design", { charter: "", dial: 0, members: [id("quill")] });
    const issue = newIssue();
    await api(alice, "PUT", `/issues/${issue.number}/teams`, { teams: ["design", "security"] });
    const pull = await pullClosing(issue);
    expect(await sendToReview(app, fresh(), pull)).toBe("sent");
    expect(reviewRuns(pull)).toHaveLength(1);
    expect(await sendToReview(app, fresh(), pull)).toBe("wait");
    // Past the hour, with the security team still unasked, it lapses to a person.
    expect(await sendToReview(app, fresh(), pull, new Date(Date.now() + 3 * 3_600_000))).toBe("lapsed");
  });

  test("naming teams is heard: an event with who and which, and the page and terminal show it", async () => {
    const issue = newIssue();
    const put = await api(alice, "PUT", `/issues/${issue.number}/teams`, { teams: ["design", "platform"] });
    expect(put.status).toBe(200);
    const heard = listEvents(app.db, { repoId: repo.id, limit: 50 }).filter(
      (e) => e.kind === "issue.teams" && Number(e.payload.number) === issue.number,
    );
    expect(heard).toHaveLength(1);
    expect(heard[0]!.payload.teams).toEqual(["design", "platform"]);
    expect(heard[0]!.actorId).toBe(alice.id);
    // A refused naming says nothing.
    await api(alice, "PUT", `/issues/${issue.number}/teams`, { teams: ["nope"] });
    expect(listEvents(app.db, { repoId: repo.id, limit: 50 }).filter((e) => e.kind === "issue.teams" && Number(e.payload.number) === issue.number)).toHaveLength(1);
    // The page's timeline carries it, and its live client listens for it.
    const page = await (await fetch(`${base()}/issues/${issue.number}`, { headers: { cookie: cookie(alice) } })).text();
    expect(page).toContain("changed the teams");
    expect(await withScripts(servers.url, page)).toContain("'issue.teams'");
    // A reader of the terminal who cannot write still sees the teams.
    const terminal = headlessTerminal(140, 40);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user: bob },
      { terminal, exitHooks: false },
    );
    tui.start();
    try {
      await settleApp(tui);
      tui.push(issueScreen(session, tui.ctx, local(session, fresh()), issue.number));
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("teams: Design, Platform");
    } finally {
      tui.stop();
    }
  });

  test("one reviewer on both teams gets one run, and their approval answers both", async () => {
    saveTeam(app.db, "design", { charter: "", dial: 0, members: [id("quill")] });
    saveTeam(app.db, "data-science", { charter: "", dial: 0, members: [id("quill")] });
    const issue = newIssue();
    await api(alice, "PUT", `/issues/${issue.number}/teams`, { teams: ["design", "data-science"] });
    const pull = await pullClosing(issue);
    expect(await sendToReview(app, fresh(), pull)).toBe("sent");
    expect(reviewRuns(pull)).toHaveLength(1);
    submitReview(app.db, { issueId: pull.id, authorId: id("quill"), state: "approved", commitOid: pull.headOid });
    expect(teamVerdicts(app.db, pull).map((v) => v.state)).toEqual(["approved", "approved"]);
    expect(await sendToReview(app, fresh(), pull)).toBe("done");
    expect(reviewRuns(pull)).toHaveLength(1);
  });
});
