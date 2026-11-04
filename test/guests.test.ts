/**
 * Roles, part 2 (#2302): a guest cannot own a repository, make an app their
 * own or start a crew run, through the page and through the API; a member
 * can; and every older refusal keeps its own reason.
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setArchivedIn } from "./helpers/archive.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { changeCapacity } from "../src/actions/capacity.ts";
import { proposePlan } from "../src/actions/plan.ts";
import { redirectProposal } from "../src/actions/proposals.ts";
import { ARCHIVED_WHY } from "../src/core/repos.ts";
import {} from "../src/core/agents.ts";
import { getProposal } from "../src/core/proposals.ts";
import { listComments } from "../src/core/issues.ts";
import { ensureDirectionIssue } from "../src/crew/autonomy.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { newApp } from "../src/actions/apps.ts";
import { createRepo, forkRepo } from "../src/actions/repos.ts";
import { makeItYours } from "../src/actions/make_it_yours.ts";
import { NOT_A_MEMBER, setMember } from "../src/core/roles.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { cancelRun, createRun, listRuns } from "../src/core/runs.ts";
import { addComment } from "../src/actions/issues.ts";
import { requeueRepoRun } from "../src/actions/runs.ts";
import { proposeResolution } from "../src/crew/proposal.ts";
import { agentFor, queueAgentRun, sweepAssigned } from "../src/crew/dispatch.ts";
import { getIssueById } from "../src/core/issues.ts";
import { convergeFork } from "../src/crew/converge.ts";
import { convergeWords } from "../src/actions/follow.ts";
import { mcpTool } from "./helpers/mcp.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("a guest cannot own, copy or run", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User; // guest
  let carol: User; // member
  let dave: User; // guest, email unproven
  let garden: Repo;
  let lab: Repo; // bob's, with an agent on its crew
  let helper: User;

  const token = (u: User) => createToken(app.db, u.id, "rw", "rw").token;
  const cookie = (u: User) => `forge_session=${createSession(app.db, u.id).token}`;
  const api = (path: string, u: User, body: unknown = {}) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token(u)}` },
      body: JSON.stringify(body),
    });
  const form = (path: string, u: User, fields: Record<string, string>) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: { cookie: cookie(u), origin: servers.url },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });
  const mk = async (username: string, extra: { isAdmin?: boolean; trusted?: boolean } = {}) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: extra.trusted ?? true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      ...(extra.isAdmin ? { adminIfFirst: true } : {}),
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-guests-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    alice = await mk("alice", { isAdmin: true });
    bob = await mk("bob");
    carol = await mk("carol");
    dave = await mk("dave", { trusted: false });
    setMember(app.db, carol.id, true, alice.id, new Date());
    const made = await newApp(app, alice, { name: "garden", description: "g", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    garden = made.value.repo;
    // bob owns a repository (made before the guard), with an agent on its crew.
    const own = await createRepo(app, alice, { name: "lab", visibility: "private" });
    if (!own.ok) throw new Error(own.error);
    app.db.query("UPDATE repo SET owner_id = ?1 WHERE id = ?2").run(bob.id, own.value.id);
    lab = getRepoById(app.db, own.value.id)!;
    const agent = await createAgent(app, alice, { username: "helper" });
    if (!agent.ok) throw new Error(String(agent.error));
    helper = agent.value.user;
    const crewed = addToCrew(app, bob, lab, "helper");
    if (!crewed.ok) throw new Error(crewed.error);
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("creating a repository: refused to a guest by the action, the API and the page; a member may", async () => {
    const acted = await createRepo(app, bob, { name: "mine" });
    expect(acted).toMatchObject({ ok: false, error: "not_member" });

    const res = await api("/api/v1/repos", bob, { name: "mine" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_member", message: NOT_A_MEMBER });

    const page = await form("/new", bob, { name: "mine", owner: "" });
    expect(await page.text()).toContain(NOT_A_MEMBER);
    expect((await api("/api/v1/repos", bob, { name: "mine" })).status).toBe(403);

    expect((await api("/api/v1/repos", carol, { name: "hers" })).status).toBe(201);
    expect((await form("/new", carol, { name: "hers-too", owner: "" })).status).toBe(303);
  });

  test("a plain fork is the same act", async () => {
    expect(await forkRepo(app, bob, garden)).toMatchObject({ ok: false, error: "not_member" });
    const res = await api("/api/v1/repos/alice/garden/forks", bob);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).message).toBe(NOT_A_MEMBER);
  });

  test("make it yours: refused to a guest, plan and making, by the action, the API and the page; a member may", async () => {
    expect(await makeItYours(app, bob, garden, { dryRun: false })).toMatchObject({
      ok: false,
      error: { kind: "not_member" },
    });
    for (const body of [{}, { dryRun: false }]) {
      const res = await api("/api/v1/repos/alice/garden/make-it-yours", bob, body);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "not_member", message: NOT_A_MEMBER });
    }
    const posted = await form("/alice/garden/make-it-yours", bob, {});
    expect(posted.status).toBe(303);
    const flash = await (
      await fetch(`${servers.url}${posted.headers.get("location")}`, {
        headers: { cookie: [cookie(bob), ...(posted.headers.getSetCookie() ?? []).map((c) => c.split(";")[0])].join("; ") },
      })
    ).text();
    expect(flash).toContain(NOT_A_MEMBER);

    const ok = await api("/api/v1/repos/alice/garden/make-it-yours", carol, { dryRun: false });
    expect(ok.status).toBe(201);
  });

  test("starting a run: assigning or requeueing an agent is refused to a guest; a member's goes through", async () => {
    const issue = openIssue(app, bob, lab, { title: "weed", body: "" });
    if (!issue.ok) throw new Error(String(issue.error));
    const asked = assignIssue(app, bob, lab, issue.value, helper);
    expect(asked).toMatchObject({ ok: false, error: "not_member" });
    const res = await fetch(`${servers.url}/api/v1/repos/bob/lab/issues/${issue.value.number}/assignee`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${token(bob)}` },
      body: JSON.stringify({ assignee: "helper" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).message).toBe(NOT_A_MEMBER);
    expect(listRuns(app.db, lab.id, { kind: "agent", limit: 10 })).toHaveLength(0);

    // Promoted, the same account may.
    setMember(app.db, bob.id, true, alice.id, new Date());
    expect(assignIssue(app, bob, lab, issue.value, helper).ok).toBe(true);
    setMember(app.db, bob.id, false, alice.id, new Date());
  });

  test("older refusals keep their own reasons: unverified, agent, stranger to a private repository", async () => {
    // Unverified (and a guest): told to verify first, not that they are no member.
    expect(await createRepo(app, dave, { name: "d" })).toMatchObject({ ok: false, error: "unverified" });
    const unproven = await api("/api/v1/repos/alice/garden/make-it-yours", dave, { dryRun: false });
    expect(await unproven.json()).toMatchObject({ error: "unverified" });
    // An agent owns nothing it was not given, and is not a guest.
    expect(await createRepo(app, helper, { name: "h" })).toMatchObject({ ok: false, error: "forbidden_owner" });
    // A private repository is not there for a stranger, member or not.
    const hidden = await api("/api/v1/repos/bob/lab/make-it-yours", carol, {});
    expect(hidden.status).toBe(404);
  });

  test("an admin is never a guest, and no setting turns the guard off", async () => {
    expect((await api("/api/v1/repos", alice, { name: "admins" })).status).toBe(201);
    expect(changeCapacity(app, alice, "guard_guests" as never, "off").ok).toBe(false);
    const capacity = await mcpTool(servers.url, createToken(app.db, alice.id, "admin", "admin").token, "capacity", {});
    expect(JSON.stringify(capacity)).not.toContain("guard_guests");
    expect((await api("/api/v1/repos", bob, { name: "open-door" })).status).toBe(403);
  });

  test("push-to-create: a guest's push to a new repository is refused with the words; a member's is not", async () => {
    const basic = (u: User) => `Basic ${btoa(`${u.username}:${token(u)}`)}`;
    const adv = (u: User, repo: string) =>
      fetch(`${servers.url}/${u.username}/${repo}.git/info/refs?service=git-receive-pack`, {
        headers: { authorization: basic(u) },
      });
    const refused = await (await adv(bob, "pushed")).text();
    expect(refused).toContain(`Not made: ${NOT_A_MEMBER}`);
    const allowed = await adv(carol, "pushed");
    expect(await allowed.text()).not.toContain(NOT_A_MEMBER);
  });

  test("MCP make_it_yours: not_member for a guest", async () => {
    const guest = await mcpTool(servers.url, token(bob), "make_it_yours", { repo: "alice/garden" });
    expect(guest.error ?? "").toContain(NOT_A_MEMBER);
  });

  test("requeueing a run is refused to a guest, and not for the reason of membership to a member", async () => {
    const issue = openIssue(app, alice, lab, { title: "again", body: "" });
    if (!issue.ok) throw new Error(String(issue.error));
    const run = createRun(app.db, { repoId: lab.id, kind: "agent", issueId: issue.value.id, actorId: helper.id, reason: "assigned" });
    cancelRun(app.db, run.id, "test");
    expect(requeueRepoRun(app, bob, lab, run.id)).toMatchObject({ ok: false, error: "not_member" });
    setMember(app.db, bob.id, true, alice.id, new Date());
    const again = requeueRepoRun(app, bob, lab, run.id);
    expect(again.ok === false && again.error === "not_member").toBe(false);
    setMember(app.db, bob.id, false, alice.id, new Date());
  });

  test("asking the crew to resolve a conflict is refused to a guest", async () => {
    const pull = { state: "open", id: "none", number: 1 } as any;
    expect(await proposeResolution(app, bob, lab, pull)).toMatchObject({ ok: false, error: "not_member" });
    setMember(app.db, bob.id, true, alice.id, new Date());
    const member = await proposeResolution(app, bob, lab, pull);
    expect(member.ok === false && member.error === "not_member").toBe(false);
    setMember(app.db, bob.id, false, alice.id, new Date());
  });

  test("a guest's word starts no run: the comment posts, the queue stays empty; a member's queues one", async () => {
    const opened = openIssue(app, alice, lab, { title: "talk", body: "" });
    if (!opened.ok) throw new Error(String(opened.error));
    const issue = opened.value;
    app.db.query("UPDATE issue SET assignee_id = ?1 WHERE id = ?2").run(helper.id, issue.id);
    const before = listRuns(app.db, lab.id, { kind: "agent", limit: 50 }).length;
    const said = addComment(app, bob, lab, issue, "@helper please look");
    expect(said.ok).toBe(true);
    const fresh = getIssueById(app.db, issue.id)!;
    const agent = agentFor(app, fresh)!;
    expect(queueAgentRun(app, lab, fresh, agent, "feedback", bob.id)).toBeUndefined();
    expect(listRuns(app.db, lab.id, { kind: "agent", limit: 50 })).toHaveLength(before);
    setMember(app.db, bob.id, true, alice.id, new Date());
    expect(queueAgentRun(app, lab, fresh, agent, "feedback", bob.id)).toBeDefined();
    setMember(app.db, bob.id, false, alice.id, new Date());
  });

  test("converge: a guest is refused with the words before anything is written; no issue is left for the sweep", async () => {
    const issues = () => app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM issue WHERE repo_id = ?1").get(lab.id)!.n;
    const before = issues();
    const out = await convergeFork(app, lab, garden, bob);
    expect(out).toEqual({ kind: "not_member" });
    expect(convergeWords(out, "alice/garden").message).toContain(NOT_A_MEMBER);
    expect(issues()).toBe(before);
    const assigned = app.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM issue WHERE repo_id = ?1 AND assignee_id IS NOT NULL AND title LIKE 'Take updates%'")
      .get(lab.id)!.n;
    expect(assigned).toBe(0);
  });
  test("redirecting a wave: a guest's own pending proposal is refused before anything is written", async () => {
    seatAs(app.db, lab.id, helper.id, "planner");
    const direction = ensureDirectionIssue(app, alice, lab)!;
    const proposed = proposePlan(app, alice, lab, [{ key: "a", title: "Weed", body: "", blockedBy: [] }], {
      title: "Spring",
    });
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
    const id = proposed.value.id;
    const comments = listComments(app.db, direction.id).length;

    expect(redirectProposal(app, bob, id, "Roses first")).toEqual({
      ok: false,
      error: { code: "forbidden", message: NOT_A_MEMBER },
    });
    expect(getProposal(app.db, id)!.state).toBe("pending");
    expect(listComments(app.db, direction.id)).toHaveLength(comments);
    expect(getIssueById(app.db, direction.id)!.assigneeId).toBe(direction.assigneeId);
    expect(listRuns(app.db, lab.id, { kind: "agent", limit: 50 }).some((r) => r.issueId === direction.id)).toBe(false);

    // Promoted, the same words go through.
    setMember(app.db, bob.id, true, alice.id, new Date());
    expect(redirectProposal(app, bob, id, "Roses first").ok).toBe(true);
    setMember(app.db, bob.id, false, alice.id, new Date());
    expect(getProposal(app.db, id)!.state).toBe("redirected");
  });

  test("redirecting a wave in an archived repository is refused with the archived line, and nothing is written", () => {
    const proposed = proposePlan(app, alice, lab, [{ key: "a", title: "Prune", body: "", blockedBy: [] }], {
      title: "Autumn",
    });
    if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
    const id = proposed.value.id;
    const direction = ensureDirectionIssue(app, alice, lab)!;
    const comments = listComments(app.db, direction.id).length;
    const archived = setArchivedIn(app.db, lab, true);
    setMember(app.db, bob.id, true, alice.id, new Date());
    expect(redirectProposal(app, bob, id, "Roses first")).toEqual({
      ok: false,
      error: { code: "invalid", message: ARCHIVED_WHY },
    });
    expect(getProposal(app.db, id)!.state).toBe("pending");
    expect(listComments(app.db, direction.id)).toHaveLength(comments);
    setArchivedIn(app.db, archived, false);
    expect(redirectProposal(app, bob, id, "Roses first").ok).toBe(true);
    setMember(app.db, bob.id, false, alice.id, new Date());
  });

  test("the wake-up sweep starts no run on an issue a guest assigned, and a hundred of them do not hold back a member's", async () => {
    // Back to building: a dispatch gives a planner no build (#8907).
    seatAs(app.db, lab.id, helper.id, "builder");
    // As an assignment made before the guard (or by a member since demoted):
    // the agent set, the event kept.
    const assignedBy = (who: User, title: string) => {
      const opened = openIssue(app, alice, lab, { title, body: "" });
      if (!opened.ok) throw new Error(String(opened.error));
      app.db.query("UPDATE issue SET assignee_id = ?1 WHERE id = ?2").run(helper.id, opened.value.id);
      app.bus.append({
        kind: "issue.assigned",
        repoId: lab.id,
        actorId: who.id,
        payload: { number: opened.value.number, assignee: helper.username, agent: true },
      });
      return opened.value;
    };
    const runsOn = (id: string) => listRuns(app.db, lab.id, { kind: "agent", limit: 500 }).filter((r) => r.issueId === id);
    // More than the sweep takes at once, all older than the member's.
    const guests = Array.from({ length: 101 }, (_, n) => assignedBy(bob, `a guest's old assignment ${n}`));
    const admins = assignedBy(alice, "an admin's assignment");

    sweepAssigned(app);
    expect(guests.filter((g) => runsOn(g.id).length > 0)).toHaveLength(0);
    expect(runsOn(admins.id)).toHaveLength(1);

    // The same assignment, once its assigner is a member, is picked up.
    setMember(app.db, bob.id, true, alice.id, new Date());
    sweepAssigned(app);
    setMember(app.db, bob.id, false, alice.id, new Date());
    expect(runsOn(guests[0]!.id)).toHaveLength(1);
  });
});
