/**
 * Teams drive the crew (#571): a team membership carries a role, and an
 * org repository's crew is the agents on the org's write and admin teams,
 * each in that role. With no agent on such a team, the per-repo roster is
 * the crew, unchanged. The routing reads one function, `crewSeats`; the
 * reviewer it picks comes from there. The API takes and validates `role`;
 * the org page lists each team's members with their roles, escaped.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import {
  addCrew,
  createAgentRow,
  crewSeats,
  crewWithRole,
  listCrewRoles,
  reposWithBuilder,
} from "../src/core/agents.ts";
import {
  addTeamMember,
  createOrg,
  createTeam,
  listTeamMemberRoles,
  type Team,
} from "../src/core/orgs.ts";
import { createRepo, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { reviewersOf } from "../src/crew/review.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { listEvents } from "../src/core/events.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const ALL = ["planner", "builder", "reviewer"] as const;

describe("teams drive the crew", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let juniper: User;
  let sentinel: User;
  let mason: User;
  let org: User;
  let crewTeam: Team;
  let readers: Team;
  let teamed: Repo;
  let rostered: Repo;
  let personal: Repo;
  let rw = "";
  let cookie = "";

  const user = async (username: string, agent = false): Promise<User> => {
    const made = await createUser(app.db, {
      username,
      email: `${username}@forge.test`,
      ...(agent
        ? { agent: true, origin: "agent" as const }
        : { password: "a-good-passphrase", origin: "seed" as const, trusted: true }),
    });
    if (!made.ok) throw new Error(`seed ${username}: ${made.error}`);
    if (agent) createAgentRow(app.db, { userId: made.value.id, roles: ALL });
    return made.value;
  };

  const repo = async (ownerId: string, name: string): Promise<Repo> => {
    const made = await createRepo(app.db, app.reposRoot, { ownerId, name, visibility: "public" });
    if (!made.ok) throw new Error(`repo ${name}: ${made.error}`);
    return made.value;
  };

  const names = (agents: { user: User }[] | undefined) => (agents ?? []).map((a) => a.user.username);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-teams-crew-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    alice = await user("alice");
    juniper = await user("juniper", true);
    sentinel = await user("sentinel", true);
    mason = await user("mason", true);
    const made = createOrg(app.db, "acme", alice.id);
    if (!made.ok) throw new Error(made.error);
    org = made.value;
    const t = createTeam(app.db, org.id, "Crew", "write");
    const r = createTeam(app.db, org.id, "Readers", "read");
    if (!t.ok || !r.ok) throw new Error("teams");
    crewTeam = t.value;
    readers = r.value;
    teamed = await repo(org.id, "teamed");
    rostered = await repo(org.id, "rostered");
    personal = await repo(alice.id, "own");
    // Today's roster on both org repos and the personal one: juniper reviews, sentinel builds.
    for (const target of [teamed, rostered, personal]) {
      addCrew(app.db, target.id, juniper.id, alice.id, "reviewer");
      addCrew(app.db, target.id, sentinel.id, alice.id, "builder");
    }
    rw = createToken(app.db, alice.id, "admin", "admin").token;
    cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  });

  afterAll(async () => {
    servers?.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a membership defaults to member, and the column refuses anything else", () => {
    expect(addTeamMember(app.db, readers, alice.id)).toBe(true);
    expect(listTeamMemberRoles(app.db, readers.id)).toEqual([{ user: expect.objectContaining({ username: "alice" }), role: "member" }]);
    expect(() =>
      app.db.query("UPDATE team_member SET role = 'king' WHERE team_id = ?1").run(readers.id),
    ).toThrow();
  });

  test("with no agent seated by a write team the roster is the crew, unchanged", () => {
    // An agent on a read team grants nothing.
    expect(addTeamMember(app.db, readers, mason.id, "reviewer")).toBe(true);
    for (const target of [teamed, rostered, personal]) {
      expect(listCrewRoles(app.db, target.id).map((c) => [c.agent.user.username, c.role])).toEqual([
        ["juniper", "reviewer"],
        ["sentinel", "builder"],
      ]);
      expect(names(reviewersOf(app.db, target.id))).toEqual(["juniper"]);
    }
  });

  test("a write team with a reviewer is the crew: the routing picks its reviewer", () => {
    expect(addTeamMember(app.db, crewTeam, mason.id, "reviewer")).toBe(true);
    expect(addTeamMember(app.db, crewTeam, sentinel.id, "builder")).toBe(true);
    // Every repository the org owns now reads its crew from the team …
    for (const target of [teamed, rostered]) {
      expect(listCrewRoles(app.db, target.id).map((c) => [c.agent.user.username, c.role])).toEqual([
        ["mason", "reviewer"],
        ["sentinel", "builder"],
      ]);
      expect(names(reviewersOf(app.db, target.id))).toEqual(["mason"]);
      expect(names(crewWithRole(app.db, [target.id], "builder").get(target.id))).toEqual(["sentinel"]);
    }
    // … and a repository with no org keeps its roster: juniper still reviews it.
    expect(names(reviewersOf(app.db, personal.id))).toEqual(["juniper"]);
    expect([...crewSeats(app.db, [teamed.id, personal.id]).keys()].sort()).toEqual([teamed.id, personal.id].sort());
  });

  test("a write team without a reviewer leaves the seat empty, not the roster's", () => {
    app.db.query("UPDATE team_member SET role = 'planner' WHERE team_id = ?1 AND user_id = ?2").run(crewTeam.id, mason.id);
    expect(reviewersOf(app.db, teamed.id)).toEqual([]);
    expect(names(crewWithRole(app.db, [teamed.id], "planner").get(teamed.id))).toEqual(["mason"]);
    expect(reposWithBuilder(app.db, [teamed.id, personal.id])).toEqual(new Set([teamed.id, personal.id]));
    expect(names(reviewersOf(app.db, personal.id))).toEqual(["juniper"]);
  });

  test("a plain member of a write team holds no seat, so a membership from before roles changes no crew", async () => {
    const second = createTeam(app.db, org.id, "Second", "write");
    if (!second.ok) throw new Error(second.error);
    expect(addTeamMember(app.db, second.value, juniper.id)).toBe(true);
    expect(listCrewRoles(app.db, teamed.id).some((c) => c.agent.user.id === juniper.id)).toBe(false);
    // An org whose write teams hold only members keeps its roster.
    const other = createOrg(app.db, "plain", alice.id);
    if (!other.ok) throw new Error(other.error);
    const writers = createTeam(app.db, other.value.id, "Writers", "write");
    if (!writers.ok) throw new Error(writers.error);
    expect(addTeamMember(app.db, writers.value, mason.id)).toBe(true);
    const plain = await repo(other.value.id, "plain-repo");
    addCrew(app.db, plain.id, juniper.id, alice.id, "reviewer");
    expect(crewSeats(app.db, [plain.id]).get(plain.id)?.map((s) => [s.agent.user.username, s.role])).toEqual([["juniper", "reviewer"]]);
    expect(names(reviewersOf(app.db, plain.id))).toEqual(["juniper"]);
    expect(addTeamMember(app.db, crewTeam, juniper.id, "reviewer")).toBe(true);
    expect(names(reviewersOf(app.db, teamed.id))).toEqual(["juniper"]);
  });

  const api = (method: string, path: string, body?: unknown) =>
    fetch(`${servers.url}/api/v1/orgs/acme/teams/crew/members${path}`, {
      method,
      headers: {
        authorization: `Bearer ${rw}`,
        origin: servers.url,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test("POST accepts and validates a role; GET lists it", async () => {
    const bad = await api("POST", "", { user: "mason", role: "king" });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: string }).error).toBe("bad_role");
    const set = await api("POST", "", { user: "mason", role: "reviewer" });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ added: false, role: "reviewer" });
    const listed = ((await (await api("GET", "")).json()) as { items: { username: string; role: string }[] }).items;
    expect(listed.map((m) => [m.username, m.role])).toEqual([
      ["juniper", "reviewer"],
      ["mason", "reviewer"],
      ["sentinel", "builder"],
    ]);
  });

  test("DELETE with a role takes that role off and keeps the member; a bad role is refused", async () => {
    expect((await api("DELETE", "/mason?role=king")).status).toBe(422);
    expect((await api("DELETE", "/mason?role=builder")).status).toBe(404);
    expect((await api("DELETE", "/mason?role=reviewer")).status).toBe(204);
    expect(listTeamMemberRoles(app.db, crewTeam.id).find((m) => m.user.id === mason.id)?.role).toBe("member");
    expect((await api("DELETE", "/mason")).status).toBe(204);
    expect(listTeamMemberRoles(app.db, crewTeam.id).some((m) => m.user.id === mason.id)).toBe(false);
  });

  test("the org page lists each team's members with their roles, escaped", async () => {
    app.db.query("UPDATE user SET username = 'sen<b>' WHERE id = ?1").run(sentinel.id);
    const page = await (await fetch(`${servers.url}/acme`, { headers: { cookie } })).text();
    app.db.query("UPDATE user SET username = 'sentinel' WHERE id = ?1").run(sentinel.id);
    expect(page).toContain("<dt>juniper</dt><dd>reviewer</dd>");
    expect(page).toContain("<dt>sen&lt;b&gt;</dt><dd>builder</dd>");
    expect(page).not.toContain("sen<b>");
  });

  const roleEvents = () =>
    listEvents(app.db, { limit: 200 }).filter((e) => e.kind === "team.member_role_set");

  test("a role change on a member is told on the outbox, with who, from and to", async () => {
    const before = roleEvents().length;
    expect((await api("POST", "", { user: "juniper", role: "planner" })).status).toBe(200);
    const heard = roleEvents();
    expect(heard.length).toBe(before + 1);
    const last = heard.find((e) => e.payload.role === "planner" && e.payload.user === "juniper")!;
    expect(last.actorId).toBe(alice.id);
    expect(last.payload.from).toBe("reviewer");
    // Setting the role they already hold, or a refused one, says nothing.
    await api("POST", "", { user: "juniper", role: "planner" });
    await api("POST", "", { user: "juniper", role: "king" });
    expect(roleEvents().length).toBe(before + 1);
    // Taking the role off is a change too.
    expect((await api("DELETE", "/juniper?role=planner")).status).toBe(204);
    expect(roleEvents().length).toBe(before + 2);
    expect((await api("POST", "", { user: "juniper", role: "reviewer" })).status).toBe(200);
  });

  const mcp = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
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
        params: { name: "org_teams", arguments: args },
      }),
    });
    const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    return { text: body.result.content[0]!.text, isError: body.result.isError === true };
  };

  test("MCP org_teams takes a role on add_member, refuses a bad one, and lists members with roles", async () => {
    const bad = await mcp(rw, { org: "acme", action: "add_member", team: "Crew", user: "mason", role: "king" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("bad_role");
    const added = await mcp(rw, { org: "acme", action: "add_member", team: "Crew", user: "mason", role: "builder" });
    expect(added.isError).toBe(false);
    expect(JSON.parse(added.text)).toEqual({ added: true, role: "builder" });
    const listed = await mcp(rw, { org: "acme", action: "members", team: "Crew" });
    expect(JSON.parse(listed.text)).toContainEqual({ user: "mason", role: "builder" });
    // Someone who is not an org admin is told there is no such team.
    const outsider = createToken(app.db, mason.id, "admin", "admin").token;
    expect((await mcp(outsider, { org: "acme", action: "members", team: "Crew" })).isError).toBe(true);
    expect((await api("DELETE", "/mason")).status).toBe(204);
  });

  test("the terminal sets a role with r, and the org page shows it on the next request", async () => {
    const terminal = headlessTerminal(140, 32);
    const { app: tui } = createForgeApp(
      app,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user: alice },
      { terminal, exitHooks: false },
    );
    tui.start();
    const key = (k: string, ctrl = false) => tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    const press = async (...keys: string[]) => {
      keys.forEach((k) => key(k));
      await settleApp(tui);
    };
    try {
      key("k", true);
      await settleApp(tui);
      for (const ch of "Organization teams") key(ch);
      await press("enter");
      // Crew is the first team of acme, the first org.
      await press("enter");
      expect(tui.screen.toText()).toContain("acme / Crew");
      expect(tui.screen.toText()).toContain("r  role");
      const lineOf = (who: string) => tui.screen.toText().split("\n").find((l) => l.includes(`@${who}`)) ?? "";
      expect(lineOf("sentinel")).toContain("builder");
      await press("j", "r");
      expect(tui.screen.toText()).toContain("@sentinel: role");
      await press("enter"); // planner, the first
      expect(lineOf("sentinel")).toContain("planner");
    } finally {
      tui.stop();
    }
    expect(roleEvents().some((e) => e.payload.user === "sentinel" && e.payload.role === "planner")).toBe(true);
    const page = await (await fetch(`${servers.url}/acme`, { headers: { cookie } })).text();
    expect(page).toContain("<dt>sentinel</dt><dd>planner</dd>");
  });
});
