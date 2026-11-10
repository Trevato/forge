/**
 * The forge as an MCP server: one short JSON-RPC call per answer, a token
 * and never a cookie, `ro` reads and `rw` acts, and every tool is the same
 * action the pages call — so what a person may not do on a page they may
 * not do here.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { pullDir } from "../src/core/pulls.ts";
import { resolveOid } from "../src/git/merge.ts";
import { openIssue } from "../src/actions/issues.ts";
import {} from "../src/core/agents.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { addComment, createIssue, listIssues } from "../src/core/issues.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { getRepo, getRepoById, updateRepoSettings, type Repo } from "../src/core/repos.ts";
import { createRun, listRuns, setRunBase } from "../src/core/runs.ts";
import { getAccountCeiling } from "../src/core/account_ceiling.ts";
import { createToken } from "../src/core/tokens.ts";
import { setMember } from "../src/core/roles.ts";
import { createUser, type User } from "../src/core/users.ts";
import { savePlacement } from "../src/core/placements.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { limitChanges, limitValue } from "../src/settings/limits.ts";
import { promote } from "./helpers/members.ts";
import { showBoard } from "../src/actions/boards.ts";
import { panelData } from "../src/boards/panel_data.ts";
import { listVia } from "./mcp-list.ts";

/** tools/list's order: the tools by name, then `report`. */
const sortedThenReport = (names: string[]): string[] => [
  ...names.filter((n) => n !== "report" && n !== "start").sort((a, b) => a.localeCompare(b)),
  "report",
  "start",
];

describe("the forge over MCP", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let bob: User;
  let rw: string;
  let ro: string;
  let bobRw: string;
  let game: Repo;
  let nextId = 1;

  const listCall = async (token: string) => ({
    body: await listVia(async (p) => (await call(token, "tools/list", p)).body),
  });

  const call = async (
    token: string | null,
    method: string,
    params?: unknown,
    extra: Record<string, string> = {},
  ) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...extra,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    return {
      res,
      body: res.status === 202 ? null : ((await res.json()) as any),
    };
  };
  /** A tool's answer: its JSON value, or its error text. */
  const tool = async (token: string, name: string, args: unknown = {}) => {
    const { body } = await call(token, "tools/call", { name, arguments: args });
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text }
      : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    promote(app.db, bob);
    rw = createToken(app.db, alice.id, "rw", "rw").token;
    ro = createToken(app.db, alice.id, "ro", "ro").token;
    bobRw = createToken(app.db, bob.id, "rw", "rw").token;
    const made = await createRepo(app, alice, {
      name: "game",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    game = made.value;
    await commitToBranch(app, alice, game, {
      message: "seed",
      files: [{ path: "README.md", content: "# game\n" }],
    });
    const record = insertApp(app.db, {
      repoId: game.id,
      slug: "game",
      access: "private",
    });
    if (!record.ok) throw new Error(record.error);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a token is the only way in, and a stream is never offered", async () => {
    const anon = await call(null, "tools/list");
    expect(anon.res.status).toBe(401);
    expect(anon.res.headers.get("www-authenticate")).toContain("Bearer");
    const get = await fetch(`${base}/mcp`, {
      headers: { authorization: `Bearer ${rw}` },
    });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });

  test("a browser opening /mcp reads what it is; a client still gets the bare 405", async () => {
    const browser = await fetch(`${base}/mcp`, { headers: { accept: "text/html" } });
    expect(browser.status).toBe(405);
    expect(browser.headers.get("allow")).toBe("POST");
    expect(browser.headers.get("x-content-type-options")).toBe("nosniff");
    const text = await browser.text();
    expect(text).toContain("This is the forge's MCP server");
    expect(text).toContain("/llms.txt");
    expect(text).toContain("/.well-known/mcp.json");
    const stream = await fetch(`${base}/mcp`, { headers: { accept: "text/event-stream" } });
    expect(stream.status).toBe(405);
    expect(stream.headers.get("allow")).toBe("POST");
    expect(await stream.text()).toContain("JSON-RPC over POST");
    const bare = await fetch(`${base}/mcp`);
    expect(bare.status).toBe(405);
    expect(await bare.text()).toContain("MCP endpoint");
    const anon = await (await fetch(`${base}/mcp`, { headers: { accept: "text/html" } })).text();
    expect(anon).toContain('href="/signin"');
    expect(anon).not.toContain('href="/settings/tokens">Settings');
    const signedIn = await fetch(`${base}/mcp`, {
      headers: { accept: "text/html", authorization: `Bearer ${rw}` },
    });
    expect(signedIn.status).toBe(405);
    const page = await signedIn.text();
    expect(page).toContain('<a href="/settings/tokens">Settings › Tokens</a>');
    expect(page).not.toContain("to make a token");
  });

  test("it speaks the protocol: initialize, a notification, ping, tools/list", async () => {
    const init = await call(rw, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.res.status).toBe(200);
    expect(init.res.headers.get("content-type")).toContain("application/json");
    expect(init.body.result.protocolVersion).toBe("2025-03-26");
    expect(init.body.result.serverInfo.name).toBe("forge");
    expect(init.body.result.capabilities.tools).toEqual({});
    expect(init.body.result.capabilities.resources).toEqual({});
    // A version it has never heard of gets the one it prefers.
    const future = await call(rw, "initialize", {
      protocolVersion: "2031-01-01",
    });
    expect(future.body.result.protocolVersion).toBe("2025-06-18");

    const note = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${rw}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    expect(note.status).toBe(202);
    expect((await call(rw, "ping")).body.result).toEqual({});

    const listed = await listCall(rw);
    const names = listed.body.result.tools.map((t: { name: string }) => t.name);
    // Listed by name, one file each (#5924), and `report` last.
    expect(names).toEqual(sortedThenReport([
      "data",
      "drills",
      "sizes",
      "releases",
      "apps",
      "app_deploy",
      "new_app",
      "repo",
      "here",
      "tell",
      "templates",
      "share",
      "say",
      "issue",
      "pull",
      "preview",
      "pulls",
      "queue_gates",
      "variant",
      "edit",
      "close",
      "read_file",
      "release_keeper",
      "write_file",
      "asks",
      "asks_act",
      "asks_decide",
      "asks_proposal",
      "proposal_tokens",
      "asks_undecide",
      "seal",
      "secrets",
      "issue_teams",
      "issues",
      "iterations",
      "keep_plan",
      "knobs",
      "orgs",
      "now",
      "open_pull",
      "org_create",
      "stop",
      "health",
      "forge_view",
      "audit",
      "model_grant",
      "accounts",
      "whoami_can",
      "profile",
      "mint_invite",
      "tokens",
      "invites",
      "account_role",
      "account_suspend",
      "account_requests",
      "flag_winner",
      "restore_drill",
      "model_ceiling",
      "account_verify",
      "outsiders",
      "origins",
      "decisions_by",
      "archive",
      "detach",
      "trail",
      "migrate",
      "events",
      "reports",
      "branches",
      "builds",
      "commits",
      "waves",
      "probe",
      "following",
      "spawn",
      "forges",
      "claim_link",
      "take_back",
      "take_updates",
      "sync",
      "sever",
      "flag_set",
      "economics",
      "follow_mode",
      "fork",
      "forks",
      "fork_tree",
      "upstream",
      "propose_to_parent_forge",
      "forge_proposals",
      "converge",
      "crew",
      "family",
      "features",
      "next_steps",
      "notify",
      "thought",
      "asked",
      "assigned",
      "assign",
      "app_members",
      "app_notes",
      "egress_grants",
      "explore",
      "person",
      "bets",
      "bet",
      "pinned_forge",
      "search",
      "feed",
      "feed_chips",
      "feed_dismiss",
      "feed_like",
      "maintenance",
      "make_it_yours",
      "origin_apps",
      "front_page",
      "map",
      "merge",
      "milestones",
      "watch",
      "runs",
      "run_log",
      "limb",
      "returns",
      "review",
      "threads",
      "snapshot_now",
      "spend",
      "subscriptions",
      "usage",
      "labels",
      "land_past_gate",
      "repo_labels",
      "wait_for",
      "next_up",
      "week",
      "lift",
      "held",
      "confirm_wait",
      "attach_look",
      "hold",
      "plan",
      "atlas",
      "access",
      "capacity",
      "scorecard",
      "flags",
      "flow",
      "valves",
      "system",
      "backups",
      "telemetry_history",
      "contribute",
      "limits",
      "app_env",
      "agents",
      "teams",
      "cloud_accounts",
      "cloud_account",
      "quotas",
      "signup",
      "ssh_keys",
      "steer",
      "email_verify",
      "parent_unlink",
      "vision",
      "boards",
      "board_write",
      "board_pins",
      "pins",
      "board_delete",
      "report",
      "start",
    ]));
    const byName = new Map<string, any>(
      listed.body.result.tools.map((t: any) => [t.name, t]),
    );
    // A write leaves readOnlyHint to its default, false.
    expect(byName.get("tell").annotations).toBeUndefined();
    // The signup tool says what the setting does today, not that nothing reads it.
    const signup: string = byName.get("signup").description;
    expect(signup).not.toContain("Nothing reads it yet");
    expect(signup).not.toContain("not redeemed");
    expect(signup).toContain("invite lets in only a person with an open invite link");
    expect(signup).toContain("closed refuses every new account");
    expect(byName.get("tell").inputSchema.required).toEqual(["text"]);

    expect((await call(rw, "nothing/here")).body.error.code).toBe(-32601);
    expect(
      (await call(rw, "tools/call", { name: "nope" })).body.error.code,
    ).toBe(-32602);
  });

  test("repo and GET /api/v1/repos give the same audience; a stranger learns nothing of a private one", async () => {
    const api = async (token: string | null, path: string) =>
      fetch(`${base}/api/v1/repos/${path}`, {
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      });
    const viaApi = (await (await api(rw, "alice/game")).json()) as any;
    const viaMcp = await tool(rw, "repo", { repo: "alice/game" });
    expect(viaApi.audience.level).toBe("private");
    expect(viaMcp.value.audience).toEqual(viaApi.audience);
    expect(viaApi.audience.sentence).toStartWith("Private: only you");

    // Bob cannot read it: a 404 and the same refusal, with no names in either.
    const denied = await api(bobRw, "alice/game");
    expect(denied.status).toBe(404);
    expect(JSON.stringify(await denied.json())).not.toContain("alice");
    expect((await tool(bobRw, "repo", { repo: "alice/game" })).error).toContain("no such");
    const anon = await api(null, "alice/game");
    expect(anon.status).toBe(404);
    expect(JSON.stringify(await anon.json())).not.toContain("alice");

    // A public repository tells everyone the public sentence, signed out too.
    const open = await createRepo(app, alice, { name: "wide", visibility: "public" });
    if (!open.ok) throw new Error(String(open.error));
    const pub = (await (await api(null, "alice/wide")).json()) as any;
    expect(pub.audience.level).toBe("public");
    expect(pub.audience.sentence).toStartWith("Public: anyone can read this");
    expect(pub.audience.sentence).not.toContain("you");
    const asBob = await tool(bobRw, "repo", { repo: "alice/wide" });
    expect(asBob.value.audience).toEqual(
      ((await (await api(bobRw, "alice/wide")).json()) as any).audience,
    );
  });

  test("apps and now read what the studio reads", async () => {
    const apps = await tool(ro, "apps");
    expect(apps.value).toHaveLength(1);
    expect(apps.value[0].app).toBe("alice/game");
    expect((await tool(ro, "now")).value).toEqual([]);
    // Bob cannot see alice's private app: not in his list, not by name.
    expect((await tool(bobRw, "apps")).value).toEqual([]);
    expect(
      (await tool(bobRw, "following", { repo: "alice/game" })).error,
    ).toContain("not_found");
  });

  test("audit reads each app's contract from git, or says it has none", async () => {
    const all = await tool(ro, "audit");
    expect(all.value).toHaveLength(1);
    expect(all.value[0].app).toBe("alice/game");
    expect(all.value[0].standing).toBe("unread");
    const one = await tool(ro, "audit", { repo: "alice/game" });
    expect(one.value[0].standing).toBe("unread");
    expect((await tool(bobRw, "audit")).value).toEqual([]);
    expect(
      (await tool(bobRw, "audit", { repo: "alice/game" })).error,
    ).toContain("not_found");
  });

  test("a read token may read and not act", async () => {
    const refused = await tool(ro, "tell", {
      repo: "alice/game",
      text: "add a level",
    });
    expect(refused.error).toContain("forbidden");
    expect(listIssues(app.db, game.id, { state: "open" })).toHaveLength(0);
  });

  test("tell without a repo keeps a thought and returns its id", async () => {
    const kept = await tool(rw, "tell", { text: "  a thought, as typed " });
    expect(typeof kept.value.thought).toBe("string");
    const row = app.db
      .query("SELECT author, text, source FROM thought WHERE id = ?1")
      .get(kept.value.thought) as any;
    expect(row).toEqual({ author: alice.id, text: "  a thought, as typed ", source: "mcp" });
    expect(listIssues(app.db, game.id, { state: "open" })).toHaveLength(0);
    expect((await tool(rw, "tell", { text: 5 })).error).toContain("invalid");
    expect((await tool(ro, "tell", { text: "x" })).error).toContain("forbidden");
    // With a repo it is still an issue.
    expect(
      (await tool(rw, "tell", { repo: "nobody/none", text: "x" })).error,
    ).toContain("not_found");
  });

  test("thought returns its placement to its author only (#652)", async () => {
    const kept = await tool(rw, "tell", { text: "build a thing" });
    const id = kept.value.thought;
    expect((await tool(rw, "thought", { id })).value).toEqual({ id, placement: null, repeats: [], supersedes: [], supersededBy: null, repeatedBy: [] });
    savePlacement(app.db, {
      thoughtId: id, kind: "work", placed: [{ action: "opened", repo: "alice/game", number: 3 }],
      reply: "Opened #3.", asked: false, decidedBy: "rule", placedAt: new Date().toISOString(),
    });
    const got = await tool(rw, "thought", { id });
    expect(got.value.placement).toMatchObject({ kind: "work", reply: "Opened #3.", asked: false });
    expect((await tool(bobRw, "thought", { id })).error).toContain("not_found");
    expect((await tool(rw, "thought", { id: "nope" })).error).toContain("not_found");
  });

  test("tell is the studio's tell: an issue, a builder, a run", async () => {
    const empty = await tool(rw, "tell", { repo: "alice/game", text: "   " });
    expect(empty.error).toContain("empty");
    const nobody = await tool(rw, "tell", {
      repo: "alice/game",
      text: "add a second level\n\nwith a boss at the end",
    });
    expect(nobody.value.says).toContain("Nobody is on the crew");
    const [first] = listIssues(app.db, game.id, { state: "open" });
    expect(first!.title).toBe("add a second level");
    expect(first!.body).toContain("boss at the end");

    const made = await createAgent(app, alice, {
      username: "bot",
      brief: "Be brief.",
    });
    if (!made.ok) throw new Error(String(made.error));
    expect(addToCrew(app, alice, game, "bot").ok).toBe(true);
    const told = await tool(rw, "tell", {
      repo: "alice/game",
      text: "fix the jump",
    });
    expect(told.value.says).toContain("bot is on it");
    expect(told.value.page).toBe(
      `${base}/alice/game/issues/${told.value.issue}`,
    );
    // Assigned to the builder, which is what starts a run where a crew is
    // running; here there is none, so the run is queued by hand the way the
    // crew's router would.
    const jump = listIssues(app.db, game.id, { state: "open" }).find(
      (i) => i.title === "fix the jump",
    )!;
    expect(jump.assigneeId).toBe(made.value.user.id);
    expect(listRuns(app.db, game.id, { kind: "agent", limit: 5 })).toHaveLength(
      0,
    );
    createRun(app.db, {
      repoId: game.id,
      kind: "agent",
      issueId: jump.id,
      actorId: made.value.user.id,
      reason: "assigned",
    });

    const now = await tool(rw, "now");
    expect(now.value).toHaveLength(1);
    expect(now.value[0].app).toBe("alice/game");
    expect(now.value[0].who).toBe("bot");
    expect(now.value[0].on).toContain("fix the jump");

    // Stop is the page's stop: exact, once, and only a writer's.
    expect(
      (await tool(bobRw, "stop", { repo: "alice/game", run: now.value[0].run }))
        .error,
    ).toContain("not_found");
    const stopped = await tool(rw, "stop", {
      repo: "alice/game",
      run: now.value[0].run,
    });
    expect(stopped.value.says).toContain("Stopped run");
    expect(
      (await tool(rw, "stop", { repo: "alice/game", run: now.value[0].run }))
        .error,
    ).toContain("finished");
    expect((await tool(rw, "now")).value).toEqual([]);
  });

  test("say lands on the conversation", async () => {
    const [issue] = listIssues(app.db, game.id, { state: "open" });
    const said = await tool(rw, "say", {
      repo: "alice/game",
      number: issue!.number,
      text: "keep it under 50 lines",
    });
    expect(said.value.says).toBe(`Said on #${issue!.number}.`);
    expect(
      (await tool(rw, "say", { repo: "alice/game", number: 999, text: "x" }))
        .error,
    ).toContain("not_found");
  });

  test("close is the PATCH route's action: the same refusals, the new state answered", async () => {
    const made = await createAgent(app, alice, { username: "closer", brief: "x" });
    if (!made.ok) throw new Error(String(made.error));
    expect(addToCrew(app, alice, game, "closer").ok).toBe(true);
    seatAs(app.db, game.id, made.value.user.id, "planner");
    const botToken = createToken(app.db, made.value.user.id, "bot", "rw").token;
    const mine = (title: string) => {
      const o = openIssue(app, made.value.user, game, { title });
      if (!o.ok) throw new Error(String(o.error));
      return o.value;
    };
    const patch = async (token: string, number: number, payload: unknown) => {
      const res = await fetch(`${base}/api/v1/repos/alice/game/issues/${number}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      return { status: res.status, json: (await res.json()) as any };
    };

    // Done with no commit naming it: refused, with the API's code.
    const noNote = mine("a thing nobody did");
    const viaApi = await patch(botToken, noNote.number, { state: "closed", reason: "done" });
    expect(viaApi.json.error).toBe("forbidden");
    const refused = await tool(botToken, "close", { repo: "alice/game", number: noNote.number, reason: "done" });
    expect(refused.error).toContain("forbidden");
    expect(refused.error).toContain("already done on main");
    expect(viaApi.json.message).toContain("already done on main");

    // Its own, dropped: closed, and the answer says so.
    const own = mine("a thing to drop");
    const dropped = await tool(botToken, "close", {
      repo: "alice/game",
      number: own.number,
      reason: "dropped",
    });
    expect(dropped.value).toMatchObject({ number: own.number, state: "closed", closeReason: "dropped" });

    // A person's ask is not an agent's to drop.
    const asked = openIssue(app, alice, game, { title: "a person asks" });
    if (!asked.ok) throw new Error(String(asked.error));
    expect(
      (await tool(botToken, "close", { repo: "alice/game", number: asked.value.number, reason: "dropped" })).error,
    ).toContain("a person's ask stands in");
    // Split into an issue that is not newer than the hand-over.
    expect(
      (await tool(botToken, "close", { repo: "alice/game", number: asked.value.number, reason: "split", into: [noNote.number] })).error,
    ).toContain("opened after ");
    // A closed issue is not the planner's to close again.
    expect(
      (await tool(botToken, "close", { repo: "alice/game", number: own.number })).error,
    ).toContain("any other close is not the planner's");
    // Nor does an agent reopen.
    expect((await tool(botToken, "close", { repo: "alice/game", number: own.number, state: "open" })).error).toContain(
      "forbidden",
    );

    // A person reopens it; closing defaults to done.
    const reopened = await tool(rw, "close", { repo: "alice/game", number: own.number, state: "open" });
    expect(reopened.value).toMatchObject({ state: "open", closeReason: null });
    const closed = await tool(rw, "close", { repo: "alice/game", number: own.number });
    expect(closed.value).toMatchObject({ state: "closed", closeReason: "done" });

    // The boundary: bad words are refused before the action.
    expect((await tool(rw, "close", { repo: "alice/game", number: own.number, state: "x" })).error).toContain("invalid_state");
    expect((await tool(rw, "close", { repo: "alice/game", number: own.number, reason: "x" })).error).toContain("invalid_reason");
    expect((await tool(rw, "close", { repo: "alice/game", number: own.number, into: [0] })).error).toContain("invalid_reason");
    expect((await tool(ro, "close", { repo: "alice/game", number: own.number })).error).toContain("forbidden: this token may read, not act");
  });

  test("issue reads body, comments, labels and what it waits for; a sealed one is not found; a reader is marked untrusted", async () => {
    const mk = (title: string, body = "", sealed = false) => {
      const r = createIssue(app.db, { repoId: game.id, authorId: alice.id, title, body, sealed });
      if (!r.ok) throw new Error(String(r.error));
      return r.value;
    };
    const waiting = mk("wait for it", "the body");
    const first = mk("first");
    expect(addDependency(app.db, waiting, first, alice.id).ok).toBe(true);
    const bot = await createAgent(app, alice, { username: "issuebot", brief: "x" });
    if (!bot.ok) throw new Error(String(bot.error));
    expect(addToCrew(app, alice, game, "issuebot").ok).toBe(true);
    addComment(app.db, { issueId: waiting.id, authorId: alice.id, body: "one" });
    addComment(app.db, { issueId: waiting.id, authorId: bot.value.user.id, body: "two" });

    const read = (await tool(rw, "issue", { repo: "alice/game", number: waiting.number })).value;
    expect(read).toMatchObject({
      number: waiting.number,
      title: "wait for it",
      state: "open",
      closeReason: null,
      body: "the body",
      labels: [],
      assignee: null,
      blockedBy: [{ number: first.number, title: "first", state: "open" }],
      blocks: [],
    });
    expect(read.comments.map((c: any) => [c.author, c.authorIsAgent, c.body])).toEqual([
      ["alice", false, "one"],
      ["issuebot", true, "two"],
    ]);
    expect(read.comments[0].at).toBeString();
    expect(read.untrusted).toBeUndefined();
    const other = (await tool(rw, "issue", { repo: "alice/game", number: first.number })).value;
    expect(other.blocks.map((b: any) => b.number)).toEqual([waiting.number]);

    // Not found: no such number, and a pull's number is not an issue's.
    expect((await tool(rw, "issue", { repo: "alice/game", number: 9999 })).error).toContain("not_found");
    const branched = await commitToBranch(app, alice, game, {
      branch: "issue-kind",
      message: "a change",
      files: [{ path: "kind.txt", content: "k\n" }],
    });
    if (!branched.ok) throw new Error(JSON.stringify(branched.error));
    const opened = await openPull(app, alice, game, {
      title: "Not an issue",
      baseBranch: "main",
      headBranch: "issue-kind",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    expect((await tool(rw, "issue", { repo: "alice/game", number: opened.value.number })).value).toEqual({ kind: "pull", tool: "pull" });
    // Through MCP the card is built from the answer's repo; a pull's number has none.
    const viaPull = await call(rw, "tools/call", { name: "issue", arguments: { repo: "alice/game", number: opened.value.number } });
    expect(viaPull.body.result.structuredContent).toBeUndefined();
    const viaIssue = await call(rw, "tools/call", { name: "issue", arguments: { repo: "alice/game", number: waiting.number } });
    const card = viaIssue.body.result.structuredContent.card;
    expect(card.kind).toBe("issue");
    expect(card.rows[0].link).toMatch(/^https?:\/\/.+\/alice\/game\/issues\/\d+$/);
    expect(card.rows[0].link.endsWith(`/alice/game/issues/${waiting.number}`)).toBe(true);
    expect(card.rows.find((r: any) => r.label === "Waits for").link.endsWith(`/alice/game/issues/${first.number}`)).toBe(true);

    // Sealed: the writer reads it; a reader of a public repo is told not found.
    const pub = await createRepo(app, alice, { name: "sealedpub", visibility: "public" });
    if (!pub.ok) throw new Error(String(pub.error));
    const secret = createIssue(app.db, { repoId: pub.value.id, authorId: alice.id, title: "hole", sealed: true });
    if (!secret.ok) throw new Error(String(secret.error));
    const open = createIssue(app.db, { repoId: pub.value.id, authorId: alice.id, title: "visible" });
    if (!open.ok) throw new Error(String(open.error));
    expect((await tool(rw, "issue", { repo: "alice/sealedpub", number: secret.value.number })).value.title).toBe("hole");
    expect((await tool(bobRw, "issue", { repo: "alice/sealedpub", number: secret.value.number })).error).toContain("not_found");

    // A public issue waiting on the sealed one: the reader must not learn its title.
    expect(addDependency(app.db, open.value, secret.value, alice.id).ok).toBe(true);
    expect((await tool(bobRw, "issue", { repo: "alice/sealedpub", number: open.value.number })).value.blockedBy).toEqual([]);
    const waits = (await tool(rw, "issue", { repo: "alice/sealedpub", number: open.value.number })).value.blockedBy;
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ number: secret.value.number, title: "hole" });
    expect((await tool(bobRw, "issue", { repo: "alice/sealedpub", number: open.value.number })).value.blockedBy).not.toContainEqual(expect.objectContaining({ title: "hole" }));

    // Untrusted: bob cannot write alice/sealedpub; a crew agent is told so.
    addComment(app.db, { issueId: open.value.id, authorId: bob.id, body: "from a reader" });
    addComment(app.db, { issueId: open.value.id, authorId: alice.id, body: "from the owner" });
    expect(addToCrew(app, alice, pub.value, "issuebot").ok).toBe(true);
    const botToken = createToken(app.db, bot.value.user.id, "bot", "ro").token;
    const marked = (await tool(botToken, "issue", { repo: "alice/sealedpub", number: open.value.number })).value;
    expect(marked.comments.map((c: any) => c.untrusted)).toEqual([true, undefined]);
    expect(marked.untrusted).toBeUndefined();

    // An issue a reader filed is marked itself, for the crew agent and not for the owner.
    const theirs = createIssue(app.db, { repoId: pub.value.id, authorId: bob.id, title: "from bob" });
    if (!theirs.ok) throw new Error(String(theirs.error));
    expect((await tool(botToken, "issue", { repo: "alice/sealedpub", number: theirs.value.number })).value.untrusted).toBe(true);
    expect((await tool(rw, "issue", { repo: "alice/sealedpub", number: theirs.value.number })).value.untrusted).toBeUndefined();
  });

  test("following, take_updates and converge are the fork's page", async () => {
    const pub = await createRepo(app, alice, {
      name: "open",
      visibility: "public",
    });
    if (!pub.ok) throw new Error(String(pub.error));
    await commitToBranch(app, alice, pub.value, {
      message: "seed",
      files: [{ path: "README.md", content: "# open\n" }],
    });
    const forked = await forkRepo(app, bob, pub.value);
    if (!forked.ok) throw new Error(String(forked.error));
    const fresh = (r: Repo) => getRepoById(app.db, r.id)!;

    expect(
      (await tool(bobRw, "following", { repo: "alice/open" })).error,
    ).toContain("not_a_fork");
    expect(
      (await tool(bobRw, "following", { repo: "bob/open" })).value.state,
    ).toBe("synced");
    // Both sides change the same file: a decision, so not git's to take.
    await commitToBranch(app, bob, fresh(forked.value), {
      message: "bob",
      files: [{ path: "README.md", content: "# open, by bob\n" }],
    });
    await commitToBranch(app, alice, fresh(pub.value), {
      message: "alice",
      files: [{ path: "README.md", content: "# open, by alice\n" }],
    });
    const stands = await tool(bobRw, "following", { repo: "bob/open" });
    expect(stands.value.state).toBe("diverged");
    expect(stands.value.conflicts).toEqual(["README.md"]);
    expect(
      (await tool(bobRw, "take_updates", { repo: "bob/open" })).error,
    ).toContain("conflict");
    // Alice reads bob's public fork and may not move it.
    expect(
      (await tool(ro, "following", { repo: "bob/open" })).value.state,
    ).toBe("diverged");
    const carol = await createUser(app.db, { origin: "seed", trusted: true,
      username: "carol",
      email: "carol@forge.local",
      password: "a-good-passphrase",
    });
    if (!carol.ok) throw new Error(carol.error);
    const carolRw = createToken(app.db, carol.value.id, "rw", "rw").token;
    expect(
      (await tool(carolRw, "take_updates", { repo: "bob/open" })).error,
    ).toContain("write access");
    expect(
      (await tool(bobRw, "converge", { repo: "bob/open" })).value.kind,
    ).toBe("no_crew");
  });

  test("probe only reads, yet needs the access the page needs", async () => {
    const listed = await listCall(ro);
    const hints = Object.fromEntries(
      listed.body.result.tools.map((t: any) => [
        t.name,
        t.annotations?.readOnlyHint ?? false,
      ]),
    );
    expect(hints["probe"]).toBe(true);
    expect(hints["stop"]).toBe(false);
    // A repo the token may read, with nothing to compare with: it gets as far
    // as the app and its contract, read token or not.
    for (const token of [rw, ro])
      expect(
        (await tool(token, "probe", { repo: "alice/game" })).error,
      ).toMatch(/not_an_app|no_contract/);
    // One it may not read is no such repository.
    expect(
      (await tool(bobRw, "probe", { repo: "alice/game" })).error,
    ).toContain("not_found");
    expect(
      (await tool(rw, "probe", { repo: "alice/nothing" })).error,
    ).toContain("not_found");
  });

  test("pull carries the base tip its check was merged with (#1810)", async () => {
    const branched = await commitToBranch(app, alice, game, {
      branch: "feat",
      message: "a change",
      files: [{ path: "b.txt", content: "b\n" }],
    });
    if (!branched.ok) throw new Error(JSON.stringify(branched.error));
    const opened = await openPull(app, alice, game, {
      title: "Change",
      baseBranch: "main",
      headBranch: "feat",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    expect((await tool(ro, "pull", { repo: "alice/game", number: pull.number })).value.check).toEqual({ state: "none", baseOid: "" });
    const run = createRun(app.db, {
      repoId: game.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: branched.value.commitOid,
    });
    setRunBase(app.db, run.id, "abc1234abc1234abc1234abc1234abc1234abc12");
    const read = await tool(ro, "pull", { repo: "alice/game", number: pull.number });
    expect(read.value.check.baseOid).toBe("abc1234abc1234abc1234abc1234abc1234abc12");
    // That base is not main's tip: the green is from an older main.
    expect(read.value.checkStale).toBe(true);
    const tip = await resolveOid(
      await pullDir(app.db, app.reposRoot, game, pull),
      "refs/heads/main",
    );
    setRunBase(app.db, run.id, tip ?? "");
    expect(
      (await tool(ro, "pull", { repo: "alice/game", number: pull.number })).value.checkStale,
    ).toBe(false);
  });

  test("pull says checkStale in the MCP and the API when its check was on an older base (#2237)", async () => {
    const branched = await commitToBranch(app, alice, game, {
      branch: "stale-feat",
      message: "another change",
      files: [{ path: "c.txt", content: "c\n" }],
    });
    if (!branched.ok) throw new Error(JSON.stringify(branched.error));
    const opened = await openPull(app, alice, game, {
      title: "Stale",
      baseBranch: "main",
      headBranch: "stale-feat",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const viaApi = async () =>
      (await (
        await fetch(`${base}/api/v1/repos/alice/game/pulls/${pull.number}`, {
          headers: { authorization: `Bearer ${ro}` },
        })
      ).json()) as any;
    const viaMcp = async () =>
      (await tool(ro, "pull", { repo: "alice/game", number: pull.number })).value;
    // No check, or one that recorded no base: not stale.
    expect((await viaMcp()).checkStale).toBe(false);
    expect((await viaApi()).checkStale).toBe(false);
    const run = createRun(app.db, {
      repoId: game.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: branched.value.commitOid,
    });
    expect((await viaMcp()).checkStale).toBe(false);
    // Checked on the base's tip: not stale.
    const tip: string = (await viaApi()).status.baseOid;
    setRunBase(app.db, run.id, tip);
    expect((await viaMcp()).checkStale).toBe(false);
    expect((await viaApi()).checkStale).toBe(false);
    // The base moves on: the green is from an older main.
    const moved = await commitToBranch(app, alice, game, {
      message: "main moves",
      files: [{ path: "d.txt", content: "d\n" }],
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved.error));
    expect((await viaMcp()).checkStale).toBe(true);
    expect((await viaApi()).checkStale).toBe(true);
    // A new check on the new tip is current again.
    setRunBase(app.db, run.id, moved.value.commitOid);
    expect((await viaMcp()).checkStale).toBe(false);
    expect((await viaApi()).checkStale).toBe(false);
    // Stale again, then closed: a pull that cannot land reads false, not noise.
    setRunBase(app.db, run.id, tip);
    expect((await viaApi()).checkStale).toBe(true);
    app.db.run("UPDATE issue SET state = 'closed' WHERE id = ?", [pull.id]);
    expect((await viaMcp()).checkStale).toBe(false);
    expect((await viaApi()).checkStale).toBe(false);
  });

  test("stop takes a run id from now, and refuses a stale or foreign one", async () => {
    const run = createRun(app.db, {
      repoId: game.id,
      kind: "agent",
      actorId: alice.id,
      reason: "assigned",
    });
    expect(
      (await tool(ro, "stop", { repo: "alice/game", run: run.id })).error,
    ).toContain("forbidden");
    expect(
      (await tool(bobRw, "stop", { repo: "alice/game", run: run.id })).error,
    ).toContain("not_found");
    expect(
      (await tool(rw, "stop", { repo: "alice/game", run: "nosuchrun" })).error,
    ).toContain("not_found");
    const stopped = await tool(rw, "stop", { repo: "alice/game", run: run.id });
    expect(stopped.value.says).toBe(`Stopped run ${run.id}.`);
    const stale = await tool(rw, "stop", { repo: "alice/game", run: run.id });
    expect(stale.error).toContain("finished");
    expect(stale.error).toContain("already ended");
  });

  test("map and wait_for are the plan's own actions", async () => {
    const a = (await tool(rw, "tell", { repo: "alice/game", text: "first" }))
      .value.issue;
    const b = (await tool(rw, "tell", { repo: "alice/game", text: "second" }))
      .value.issue;
    const listed = await listCall(rw);
    const hints = Object.fromEntries(
      listed.body.result.tools.map((t: any) => [
        t.name,
        t.annotations?.readOnlyHint ?? false,
      ]),
    );
    // map writes only when given `first`, so it spells no read-only hint.
    expect([hints.map, hints.wait_for]).toEqual([false, false]);

    expect(
      (await tool(rw, "wait_for", { app: "alice/game", issue: b, blockedBy: a }))
        .value.says,
    ).toBe(`#${b} waits for #${a}.`);
    const map = (await tool(ro, "map", { app: "alice/game" })).value;
    expect(map.ready.map((i: any) => i.number)).toContain(a);
    expect(map.blockedOn.map((i: any) => i.number)).toContain(a);
    expect(map.issues.find((i: any) => i.number === b).word).toBe("blocked");
    expect(map.edges).toContainEqual({ issue: b, blockedBy: a });

    // The API's words, for a loop, a stranger issue, and a read token.
    expect(
      (await tool(rw, "wait_for", { app: "alice/game", issue: a, blockedBy: b }))
        .error,
    ).toBe("cycle: that would make a loop");
    expect(
      (await tool(rw, "wait_for", { app: "alice/game", issue: a, blockedBy: 999 }))
        .error,
    ).toBe("no_such_issue: no issue #999");
    expect(
      (await tool(ro, "wait_for", { app: "alice/game", issue: a, blockedBy: b }))
        .error,
    ).toContain("forbidden");
    // A private app is no such app to someone who cannot read it.
    expect((await tool(bobRw, "map", { app: "alice/game" })).error).toContain(
      "not_found",
    );
    expect(
      (await tool(bobRw, "wait_for", { app: "alice/game", issue: b, blockedBy: a }))
        .error,
    ).toContain("not_found");

    await tool(rw, "wait_for", { app: "alice/game", issue: b, blockedBy: a, stop: true });
    const after = (await tool(ro, "map", { app: "alice/game" })).value;
    expect(after.edges).not.toContainEqual({ issue: b, blockedBy: a });
    expect(after.ready.map((i: any) => i.number)).toContain(b);
  }, 30_000);

  test("with plans need a nod on, the plan tool stores one proposal and opens nothing", async () => {
    updateRepoSettings(app.db, getRepoById(app.db, game.id)!, { plansNeedNod: true });
    const count = async () =>
      (await tool(ro, "map", { app: "alice/game" })).value.issues.length;
    const before = await count();
    const issues = [
      { key: "a", title: "First" },
      { key: "b", title: "Second", blockedBy: ["a"] },
    ];
    const done = await tool(rw, "plan", {
      app: "alice/game",
      title: "Two steps",
      why: "worth a look",
      issues,
    });
    expect(done.value.status).toBe("proposed");
    const row = app.db
      .query<{ title: string; why: string; issues: string }, [string]>(
        "SELECT title, why, issues FROM plan_proposal WHERE id = ?1",
      )
      .get(done.value.id)!;
    expect(row.title).toBe("Two steps");
    expect(JSON.parse(row.issues).map((i: any) => i.key)).toEqual(["a", "b"]);
    expect(await count()).toBe(before);
    // The checks run as ever: a loop is refused and stores nothing.
    const loop = await tool(rw, "plan", {
      app: "alice/game",
      issues: [{ key: "x", title: "X", blockedBy: ["x"] }],
    });
    expect(loop.error).toContain("self");
  });

  test("plan opens linked issues all or none", async () => {
    updateRepoSettings(app.db, getRepoById(app.db, game.id)!, { plansNeedNod: false });
    const issues = [
      { key: "a", title: "First" },
      { key: "b", title: "Second", body: "two" },
      { key: "c", title: "Third", blockedBy: ["a", "b"] },
    ];
    const done = (await tool(rw, "plan", { app: "alice/game", issues })).value;
    const n = Object.fromEntries(
      done.opened.map((o: any) => [o.key, o.number]),
    );
    expect(done.ready).toEqual(expect.arrayContaining([n.a, n.b]));
    expect(done.ready).not.toContain(n.c);
    const map = (await tool(ro, "map", { app: "alice/game" })).value;
    expect(map.edges).toContainEqual({ issue: n.c, blockedBy: n.a });
    expect(map.edges).toContainEqual({ issue: n.c, blockedBy: n.b });

    const count = async () =>
      (await tool(ro, "map", { app: "alice/game" })).value.issues.length;
    const before = await count();
    const loop = await tool(rw, "plan", {
      app: "alice/game",
      issues: [
        { key: "x", title: "X", blockedBy: ["y"] },
        { key: "y", title: "Y", blockedBy: ["x"] },
      ],
    });
    expect(loop.error).toContain("cycle");
    const unknown = await tool(rw, "plan", {
      app: "alice/game",
      issues: [{ key: "x", title: "X", blockedBy: ["nope"] }],
    });
    expect(unknown.error).toContain('"nope"');
    const many = await tool(rw, "plan", {
      app: "alice/game",
      issues: Array.from({ length: 13 }, (_, i) => ({
        key: `k${i}`,
        title: "t",
      })),
    });
    expect(many.error).toContain("too_many");
    expect(await count()).toBe(before);

    expect(
      (await tool(ro, "plan", { app: "alice/game", issues })).error,
    ).toContain("forbidden");
  });

  test("a browser session is not a way in, even signed in", async () => {
    const signin = await fetch(`${base}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: base,
      },
      body: new URLSearchParams({
        username: "alice",
        password: "a-good-passphrase",
      }),
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toContain("=");
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: base },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });
  test("limits: admins only, dry by default, an admin-scope token to change", async () => {
    const key = "front.pinned_max";
    const admin = createToken(app.db, alice.id, "admin", "admin").token;
    // A non-admin and an agent (even one marked admin) are told nothing.
    expect((await tool(bobRw, "limits")).error).toContain("no such tool");
    const made = await createAgent(app, alice, { username: "limitbot", brief: "x" });
    if (!made.ok) throw new Error(String(made.error));
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(made.value.user.id);
    const botToken = createToken(app.db, made.value.user.id, "bot", "admin").token;
    expect((await tool(botToken, "limits")).error).toContain("no such tool");

    const before = limitValue(app.db, key);
    const listed = await tool(ro, "limits");
    expect(listed.value.limits.map((l: any) => l.key)).toContain(key);

    // The default is a dry run: nothing changes, even with an admin token.
    const dry = await tool(admin, "limits", { key, value: "13" });
    expect(dry.value.says).toContain("Would set");
    expect(limitValue(app.db, key)).toBe(before);

    // Writing needs the admin scope.
    const refused = await tool(ro, "limits", { key, value: "13", dryRun: false });
    expect(refused.error).toContain("forbidden");
    expect(limitValue(app.db, key)).toBe(before);

    const done = await tool(admin, "limits", { key, value: "13", dryRun: false });
    expect(done.value).toMatchObject({ key, from: before, to: 13 });
    expect(limitValue(app.db, key)).toBe(13);
    expect(limitChanges(app.db)[0]).toMatchObject({ key });
  });

  test("egress_grants: list, grant and revoke for a site admin; a non-admin is refused as the API refuses", async () => {
    const dest = "100.89.95.68:8101";
    const committed = await commitToBranch(app, alice, game, {
      message: "Ask for the arm",
      files: [{ path: "forge.json", content: JSON.stringify({ app: { run: "bun run src/server.ts" }, egress: [dest] }) }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const admin = createToken(app.db, alice.id, "admin", "admin").token;
    const bobAdmin = createToken(app.db, bob.id, "bobadmin", "admin").token;
    const repo = "alice/game";

    const listed = await tool(admin, "egress_grants", { repo });
    expect(listed.value.items).toEqual([
      { destination: dest, asked: true, granted: false, grantedBy: null, grantedAt: null },
    ]);

    // Bob is no admin of the repository: told nothing of it.
    expect((await tool(bobAdmin, "egress_grants", { repo })).error).toContain("not_found");
    // A token below admin scope may not read or change.
    expect((await tool(ro, "egress_grants", { repo })).error).toContain("forbidden");
    expect((await tool(rw, "egress_grants", { repo, op: "grant", destination: dest })).error).toContain("forbidden");

    const granted = await tool(admin, "egress_grants", { repo, op: "grant", destination: dest });
    expect(granted.value).toMatchObject({ destination: dest, granted: true, grantedBy: "alice" });
    expect((await tool(admin, "egress_grants", { repo, op: "grant", destination: "10.0.0.1:1" })).error).toContain("not_asked");

    // The same words the API gives a repository admin who is no site admin.
    const arm = await createRepo(app, bob, { name: "arm", visibility: "public", description: "" });
    if (!arm.ok) throw new Error(String(arm.error));
    await commitToBranch(app, bob, arm.value, {
      message: "Ask for the arm",
      files: [{ path: "forge.json", content: JSON.stringify({ app: { run: "bun run src/server.ts" }, egress: [dest] }) }],
    });
    const refused = await tool(bobAdmin, "egress_grants", { repo: "bob/arm", op: "grant", destination: dest });
    const api = await fetch(`${base}/api/v1/repos/bob/arm/egress-grants`, {
      method: "POST",
      headers: { authorization: `Bearer ${bobAdmin}`, "content-type": "application/json" },
      body: JSON.stringify({ destination: dest }),
    });
    expect(api.status).toBe(403);
    expect(refused.error).toBe(`forbidden: ${((await api.json()) as any).message}`);

    // An agent, even one marked site admin, may not change a grant.
    const bot = await createAgent(app, alice, { username: "egressbot", brief: "x" });
    if (!bot.ok) throw new Error(String(bot.error));
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(bot.value.user.id);
    const botToken = createToken(app.db, bot.value.user.id, "bot", "admin").token;
    const botGrant = await tool(botToken, "egress_grants", { repo: "bob/arm", op: "grant", destination: dest });
    expect(botGrant.error).toContain("forbidden");

    const revoked = await tool(admin, "egress_grants", { repo, op: "revoke", destination: dest });
    expect(revoked.value).toEqual({ revoked: dest });
    expect((await tool(admin, "egress_grants", { repo, op: "revoke", destination: dest })).error).toContain("no_such_grant");
    expect((await tool(admin, "egress_grants", { repo })).value.items[0].granted).toBe(false);
  });

  test("board_pins: list, pin, move, unpin for an admin person; an agent and a non-admin are refused", async () => {
    const board = { title: "Pinnable", range: "24h", refresh: "off", panels: [
      { title: "One", chart: "number", query: { source: "runs", aggregate: "count" }, w: 1, h: 1 },
      { title: "Two", chart: "number", query: { source: "runs", aggregate: "count" }, w: 1, h: 1 },
    ] };
    expect((await tool(rw, "board_write", { slug: "pinnable", board })).value).toMatchObject({ slug: "pinnable" });
    const titles = async () => (await tool(rw, "board_pins")).value.pins.map((p: any) => p.title);
    expect(await titles()).toEqual([]);
    expect((await tool(rw, "board_pins", { op: "pin", slug: "pinnable", title: "One" })).value).toMatchObject({ slug: "pinnable", title: "One" });
    await tool(rw, "board_pins", { op: "pin", slug: "pinnable", title: "Two" });
    expect(await titles()).toEqual(["One", "Two"]);
    await tool(rw, "board_pins", { op: "move", slug: "pinnable", title: "Two", by: -1 });
    expect(await titles()).toEqual(["Two", "One"]);
    expect((await tool(rw, "board_pins", { op: "move", slug: "pinnable", title: "Nope", by: 1 })).error).toContain("not_found");
    expect((await tool(rw, "board_pins", { op: "pin", slug: "pinnable", title: "Nope" })).error).toContain("not_found");
    await tool(rw, "board_pins", { op: "unpin", slug: "pinnable", title: "One" });
    expect(await titles()).toEqual(["Two"]);
    await tool(rw, "board_pins", { op: "unpin", slug: "pinnable", title: "Two" });
    expect(await titles()).toEqual([]);

    const made = await createAgent(app, alice, { username: "pinbot", brief: "x" });
    if (!made.ok) throw new Error(String(made.error));
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(made.value.user.id);
    const botToken = createToken(app.db, made.value.user.id, "bot", "rw").token;
    for (const who of [bobRw, botToken]) {
      expect((await tool(who, "board_pins")).error).toContain("forbidden");
      expect((await tool(who, "board_pins", { op: "pin", slug: "pinnable", title: "One" })).error).toContain("forbidden");
    }
    expect(await titles()).toEqual([]);
    await tool(rw, "board_delete", { slug: "pinnable" });
  });

  test("boards: list, read, write and delete for an admin person; an agent and a non-admin are refused", async () => {
    const board = { title: "Runs", range: "24h", refresh: "off", panels: [{ title: "Failed", chart: "number", query: { source: "runs", aggregate: "count" }, w: 1, h: 1 }] };
    const made = await createAgent(app, alice, { username: "boardbot", brief: "x" });
    if (!made.ok) throw new Error(String(made.error));
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(made.value.user.id);
    const botToken = createToken(app.db, made.value.user.id, "bot", "rw").token;
    for (const who of [bobRw, botToken]) {
      expect((await tool(who, "boards")).error).toContain("forbidden");
      expect((await tool(who, "board_write", { slug: "runs", board })).error).toContain("forbidden");
      expect((await tool(who, "board_delete", { slug: "runs" })).error).toContain("forbidden");
    }

    // A read-only token may not write.
    expect((await tool(ro, "board_write", { slug: "runs", board })).error).toContain("forbidden");
    expect((await tool(rw, "boards")).value.boards).toEqual([]);

    const wrote = await tool(rw, "board_write", { slug: "runs", board });
    expect(wrote.value).toMatchObject({ slug: "runs", title: "Runs" });
    expect((await tool(rw, "boards")).value.boards.map((b: any) => b.slug)).toEqual(["runs"]);
    expect((await tool(ro, "boards", { slug: "runs" })).value.panels[0].title).toBe("Failed");
    expect((await tool(rw, "boards", { slug: "nope" })).error).toContain("not_found");

    // A panel that cannot run, or a board that does not validate, is refused.
    const broken = { ...board, panels: [{ ...board.panels[0], query: { source: "nothing" } }] };
    expect((await tool(rw, "board_write", { slug: "broken", board: broken })).error).toContain("refused");
    expect((await tool(rw, "board_write", { slug: "Bad Slug", board })).error).toContain("invalid");

    expect((await tool(ro, "board_delete", { slug: "runs" })).error).toContain("forbidden");
    expect((await tool(rw, "board_delete", { slug: "runs" })).value).toEqual({ deleted: "runs" });
    expect((await tool(rw, "boards")).value.boards).toEqual([]);
    expect((await tool(rw, "board_delete", { slug: "runs" })).error).toContain("not_found");
  });

  test("boards with a panel: its data through panelData, the window judged; an agent and a non-admin are refused", async () => {
    const query = { source: "runs", aggregate: "count", groupBy: { bucket: "hour" } };
    const board = { title: "Hourly", range: "7d", refresh: "off", panels: [{ title: "Runs", chart: "line", query, w: 1, h: 1 }] };
    expect((await tool(rw, "board_write", { slug: "hourly", board })).value).toMatchObject({ slug: "hourly" });
    const from = "2026-01-01T00:00:00.000Z";
    const to = "2027-01-01T00:00:00.000Z";
    const got = (await tool(ro, "boards", { slug: "hourly", panel: 0, from, to, step: "1d" })).value;
    const shown = await showBoard(app, alice, "hourly");
    if (!shown.ok) throw new Error("no board");
    const direct = panelData(app.db, shown.value, shown.value.panels[0]!, { from, to, step: 86_400 });
    if (!direct.ok) throw new Error(direct.error);
    expect(got).toEqual({ board: "hourly", panel: 0, title: "Runs", chart: "line", from, to, step: 86_400, rows: direct.rows });
    expect((await tool(rw, "boards", { slug: "hourly", panel: 0, step: 300 })).value.step).toBe(300);
    expect((await tool(rw, "boards", { slug: "hourly", panel: 0 })).value.step).toBe(3600);
    expect((await tool(rw, "boards", { slug: "hourly", panel: 0, step: "5x" })).error).toContain("invalid_window");
    expect((await tool(rw, "boards", { slug: "hourly", panel: 0, from: "soon" })).error).toContain("invalid_window");
    expect((await tool(rw, "boards", { slug: "hourly", panel: 1 })).error).toContain("not_found");
    expect((await tool(rw, "boards", { slug: "nope", panel: 0 })).error).toContain("not_found");
    const made = await createAgent(app, alice, { username: "databot", brief: "x" });
    if (!made.ok) throw new Error(String(made.error));
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(made.value.user.id);
    const botToken = createToken(app.db, made.value.user.id, "bot", "rw").token;
    for (const who of [bobRw, botToken]) {
      expect((await tool(who, "boards", { slug: "hourly", panel: 0 })).error).toContain("forbidden");
    }
    await tool(rw, "board_delete", { slug: "hourly" });
  });

  test("ui:// card resources are listed, read, and tied to their tools", async () => {
    const list = await call(rw, "resources/list");
    const uris = list.body.result.resources.map((r: any) => r.uri).sort();
    expect(uris).toEqual([
      "ui://forge/app",
      "ui://forge/asked",
      "ui://forge/asks",
      "ui://forge/board",
      "ui://forge/crew",
      "ui://forge/explore",
      "ui://forge/feed",
      "ui://forge/flow",
      "ui://forge/forks",
      "ui://forge/issue",
      "ui://forge/map",
      "ui://forge/milestones",
      "ui://forge/pull",
      "ui://forge/pulls",
      "ui://forge/release",
      "ui://forge/run",
      "ui://forge/scorecard",
      "ui://forge/wave",
    ]);
    const read = await call(rw, "resources/read", { uri: "ui://forge/app" });
    const c = read.body.result.contents[0];
    expect(c.mimeType).toBe("text/html;profile=mcp-app");
    expect(c.text).toContain("ui/notifications/tool-result");
    expect(c.text).not.toContain("innerHTML");
    const nope = await call(rw, "resources/read", { uri: "ui://forge/nope" });
    expect(nope.body.error.code).toBe(-32002);
    const tools = (await listCall(rw)).body.result.tools;
    const meta = (n: string) => tools.find((t: any) => t.name === n)._meta?.ui?.resourceUri;
    expect(meta("apps")).toBe("ui://forge/app");
    expect(meta("new_app")).toBe("ui://forge/app");
    expect(meta("now")).toBe("ui://forge/crew");
    expect(meta("asks")).toBe("ui://forge/asks");
    expect(meta("milestones")).toBe("ui://forge/milestones");
    expect(meta("asks_act")).toBe("ui://forge/asks");
    expect(meta("map")).toBe("ui://forge/map");
    expect(meta("boards")).toBe("ui://forge/board");
    expect(meta("feed")).toBe("ui://forge/feed");
    expect(meta("issue")).toBe("ui://forge/issue");
    expect(meta("explore")).toBe("ui://forge/explore");
    expect(meta("pull")).toBe("ui://forge/pull");
    expect(meta("pulls")).toBe("ui://forge/pulls");
    expect(meta("asked")).toBe("ui://forge/asked");
    expect(meta("flow")).toBe("ui://forge/flow");
    expect(meta("scorecard")).toBe("ui://forge/scorecard");
  });

  test("tools/call pull carries the card beside an unchanged text answer", async () => {
    const branched = await commitToBranch(app, alice, game, {
      branch: "card-wire",
      message: "a change",
      files: [{ path: "card.txt", content: "c\n" }],
    });
    if (!branched.ok) throw new Error(JSON.stringify(branched.error));
    const opened = await openPull(app, alice, game, {
      title: "Card wire",
      baseBranch: "main",
      headBranch: "card-wire",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const n = opened.value.number;
    const { body } = await call(rw, "tools/call", { name: "pull", arguments: { repo: "alice/game", number: n } });
    const card = body.result.structuredContent.card;
    expect(card.kind).toBe("pull");
    expect(card.title).toBe(`#${n} Card wire`);
    const branches = card.rows.find((r: any) => r.label === "Branches");
    expect(branches.value).toBe("card-wire → main");
    expect(branches.link).toBe(`${base}/alice/game/pulls/${n}`);
    // No environment for this pull in the test runtime, so no preview to link.
    expect(card.rows.some((r: any) => r.label === "Preview")).toBe(false);
    const text = JSON.parse(body.result.content[0].text);
    expect(text.title).toBe("Card wire");
    expect(text.next).toEqual({ who: "reviewer", why: "no review yet" });
    expect("card" in text).toBe(false);
  });

  test("the pull card shows title, state, check, branches and the preview; a merged pull has no check or preview", async () => {
    const { cardFor } = await import("../src/web/studio/cards.ts");
    const origin = "https://forge.test";
    const open = cardFor(
      "pull",
      {
        number: 7,
        title: "<b>Add</b> a thing",
        state: "open",
        base: "main",
        head: "scout/7",
        check: { state: "ok" },
        mergeable: false,
        conflicts: ["a.ts"],
      },
      origin,
      { repo: "alice/game", preview: "https://p.example/" },
    )!;
    expect(open.kind).toBe("pull");
    expect(open.title).toBe("#7 <b>Add</b> a thing");
    expect(open.status).toBe("open · check green · conflicts");
    expect(open.rows.find((r) => r.label === "Branches")).toMatchObject({
      value: "scout/7 → main",
      link: "https://forge.test/alice/game/pulls/7",
    });
    expect(open.rows.find((r) => r.label === "Preview")?.link).toBe("https://p.example/");
    const merged = cardFor(
      "pull",
      { number: 8, title: "Done", state: "merged", base: "main", head: "x", check: { state: "ok" } },
      origin,
      { repo: "alice/game" },
    )!;
    expect(merged.status).toBe("merged");
    expect(merged.rows.some((r) => r.label === "Preview")).toBe(false);
    const hostile = cardFor("pull", { number: 1, state: "open", check: { state: "running" } }, origin, {
      repo: "a/b",
      preview: "javascript:alert(1)",
    })!;
    expect(hostile.status).toBe("open · check running");
    expect(hostile.rows.some((r) => r.label === "Preview")).toBe(false);
  });

  test("the issue card carries state, assignee, labels and what it waits for, with absolute links and no comments", async () => {
    const { cardFor } = await import("../src/web/studio/cards.ts");
    const answer = {
      number: 7,
      title: "<b>Fix</b>",
      state: "open",
      closeReason: null,
      body: "secret body",
      assignee: "scout",
      labels: ["bug"],
      untrusted: true,
      comments: [{ author: "x", body: "COMMENTTEXT" }],
      blockedBy: [{ number: 3, title: "T3", state: "open" }],
      blocks: [],
    };
    const card = cardFor("issue", answer, "https://forge.test", { repo: "alice/game" })!;
    expect(card.kind).toBe("issue");
    expect(card.status).toBe("open");
    expect(card.rows[0]).toEqual({ label: "#7", value: "<b>Fix</b>", link: "https://forge.test/alice/game/issues/7" });
    expect(card.rows.find((r) => r.label === "Assignee")!.value).toBe("scout");
    expect(card.rows.find((r) => r.label === "Labels")!.value).toBe("bug");
    expect(card.rows.find((r) => r.label === "Waits for")!.link).toBe("https://forge.test/alice/game/issues/3");
    expect(card.rows.some((r) => r.label === "Author" && r.value.startsWith("untrusted"))).toBe(true);
    expect(JSON.stringify(card)).not.toContain("COMMENTTEXT");
    expect(JSON.stringify(card)).not.toContain("secret body");
    expect(cardFor("issue", answer, "https://forge.test")!.rows[0]!.link).toBeUndefined();
    // A number that names a pull is not an issue: no card.
    expect(cardFor("issue", { kind: "pull", tool: "pull" }, "https://forge.test", { repo: "alice/game" })).toBeUndefined();
    expect(cardFor("issue", {}, "https://forge.test", { repo: "alice/game" })).toBeUndefined();
  });

  test("the asks card links each ask to its pull or issue, and to nothing unsafe", async () => {
    const { cardFor } = await import("../src/web/studio/cards.ts");
    const words = { decision: "Ship it?", options: ["ship", "close"] };
    const rows = [
      { line: "a", repo: "alice/game", number: 3, numberOf: "pull", words },
      { line: "b", repo: "alice/game", number: 4, numberOf: "issue", words },
      { line: "c", repo: "alice/game", words },
      { line: "d", repo: "alice", number: 5, numberOf: "pull", words },
      { line: "e", repo: "alice/game", number: 0, numberOf: "pull", words },
    ];
    const card = cardFor("asks", { rows }, "https://forge.test")!;
    expect(card.rows.map((r) => r.link)).toEqual([
      "https://forge.test/alice/game/pulls/3",
      "https://forge.test/alice/game/issues/4",
      undefined,
      undefined,
      undefined,
    ]);
    expect(cardFor("asks", { rows }, "javascript:x")!.rows.every((r) => r.link === undefined)).toBe(true);
  });

  test("the real asks result carries a link on a pull row and an issue row", async () => {
    await commitToBranch(app, alice, game, { branch: "ask-links", message: "x", files: [{ path: "ask.txt", content: "a\n" }] });
    const pull = await openPull(app, alice, game, { title: "Ask link pull", baseBranch: "main", headBranch: "ask-links" });
    const issue = await openIssue(app, alice, game, { title: "Ask link issue", body: "" });
    if (!pull.ok || !issue.ok) throw new Error("seed");
    const { setAssignee } = await import("../src/core/issues.ts");
    setAssignee(app.db, pull.value.id, alice.id);
    setAssignee(app.db, issue.value.id, alice.id);
    const { body } = await call(rw, "tools/call", { name: "asks", arguments: {} });
    const rows: any[] = body.result.structuredContent.card.rows;
    const linkOf = (label: string) => rows.find((r) => r.label.includes(label))?.link;
    expect(linkOf("Ask link pull")).toMatch(new RegExp(`^https?://[^/]+/alice/game/pulls/${pull.value.number}$`));
    expect(linkOf("Ask link issue")).toMatch(new RegExp(`^https?://[^/]+/alice/game/issues/${issue.value.number}$`));
    const { askLinesFor } = await import("../src/web/studio/asks.ts");
    const { cardFor } = await import("../src/web/studio/cards.ts");
    const lines = askLinesFor(app.db, alice);
    expect(lines.find((l) => l.id === `assigned:${pull.value.id}`)?.numberOf).toBe("pull");
    expect(lines.find((l) => l.id === `assigned:${issue.value.id}`)?.numberOf).toBe("issue");
    expect(cardFor("asks", { rows: lines }, "javascript:x")!.rows.every((r) => r.link === undefined)).toBe(true);
  });

  test("the feed card draws one linked row per item, ten at most, escaped as text", async () => {
    const { cardFor } = await import("../src/web/studio/cards.ts");
    const items = Array.from({ length: 12 }, (_, n) => ({
      actor: "scout",
      what: n === 0 ? "<b>shipped</b>" : `did ${n}`,
      app: "alice/game",
      at: new Date().toISOString(),
      link: `/alice/game/pulls/${n + 1}`,
    }));
    const card = cardFor("feed", { items }, "https://forge.test")!;
    expect(card.kind).toBe("feed");
    expect(card.title).toBe("Feed");
    expect(card.status).toBe("Latest");
    expect(card.rows).toHaveLength(10);
    expect(card.rows[0]).toEqual({
      label: "scout: <b>shipped</b>",
      value: "alice/game · just now",
      link: "https://forge.test/alice/game/pulls/1",
    });
    expect(cardFor("feed", { items, new: 3 })!.status).toBe("3 new since you last looked");
    expect(cardFor("feed", { items: [{ what: "x", link: "//evil.test/" }] }, "https://forge.test")!.rows[0]!.link).toBeUndefined();
    const { body } = await call(rw, "tools/call", { name: "feed", arguments: {} });
    expect(body.result.structuredContent.card.kind).toBe("feed");
  });

  test("runs answers with the run card, newest first, twelve rows at most", async () => {
    const { cardFor } = await import("../src/web/studio/cards.ts");
    const runs = Array.from({ length: 15 }, (_, i) => ({
      id: `r${i}`, kind: "agent", state: "done", number: i === 0 ? null : i, startedAt: 1, endedAt: 2,
    }));
    const id = "01m23vygyffx5hg2f5vm8r74sr";
    runs[1]!.id = id;
    const card = cardFor("runs", { runs }, "https://f.example", { repo: "alice/game" })!;
    expect(card.kind).toBe("run");
    expect(card.title).toBe("Runs");
    expect(card.rows[1]!.link).toBe(`https://f.example/alice/game/runs/${id}`);
    expect(card.rows[0]!.link).toBeUndefined();
    const nolink = cardFor("runs", { runs }, "https://f.example", { repo: "alice" })!;
    expect(nolink.rows[1]!.link).toBeUndefined();
    expect(card.rows).toHaveLength(12);
    expect(card.rows[0]).toEqual({ label: "agent r0", value: "done" });
    expect(card.rows[1]).toMatchObject({ label: `agent ${id}`, value: "#1 — done" });
    const { body } = await call(rw, "tools/call", { name: "runs", arguments: { repo: "alice/game" } });
    expect(body.result.structuredContent.card.kind).toBe("run");
    const tools = (await listCall(rw)).body.result.tools;
    expect(tools.find((t: any) => t.name === "runs")._meta?.ui?.resourceUri).toBe("ui://forge/run");
  });

  test("a tool result carries the card it renders", async () => {
    const { body } = await call(rw, "tools/call", { name: "apps", arguments: {} });
    const card = body.result.structuredContent.card;
    expect(card.kind).toBe("app");
    expect(card.rows.some((r: any) => r.label === "alice/game")).toBe(true);
    const asks = await call(rw, "tools/call", { name: "asks", arguments: {} });
    expect(asks.body.result.structuredContent.card.kind).toBe("asks");
  });

  test("ship and close card actions never apply at once and always meet the target tool's required fields", async () => {
    const { cardFor } = await import("../src/web/studio/cards.ts");
    const tools = (await listCall(rw)).body.result.tools;
    const cards = [
      cardFor("apps", [{ app: "alice/game", live: "up" }]),
      cardFor("now", [{ who: "scout", app: "alice/game", run: "r1", on: "#1", state: "going" }]),
      cardFor("asks", {
        rows: [
          { line: "a", kind: "look", items: ["x:1"], repo: "alice/game", number: 3, words: {} },
          { line: "b", kind: "review", items: ["x:2"], words: {} },
        ],
      }),
    ];
    let actions = 0;
    for (const card of cards)
      for (const a of [...card!.actions, ...card!.rows.flatMap((r) => r.actions ?? [])]) {
        actions++;
        expect(a.args["dryRun"]).not.toBe(false);
        const t = tools.find((x: any) => x.name === a.tool);
        // A words action gets `text` from the shell's field when pressed.
        for (const f of (t.inputSchema.required ?? []).filter((f: string) => !(a.words && f === "text"))) {
          expect(a.args[f]).toBeDefined();
          expect(a.args[f]).not.toBe("");
        }
      }
    expect(actions).toBeGreaterThan(2);
  });

  test("a tell carries where it was told from, and refuses a malformed context", async () => {
    const told = await tool(rw, "tell", {
      repo: "alice/game",
      text: "make the button blue",
      context: {
        page: "https://game.example/play?level=2",
        run: "run_abc",
        commit: "deadbeef1",
        said: "the button is hard to see",
      },
    });
    const issues = listIssues(app.db, game.id, {});
    const issue = issues.find((i) => i.title === "make the button blue");
    expect(issue?.body).toContain("page: https://game.example/play?level=2");
    expect(issue?.body).toContain("commit: deadbeef1");
    expect(issue?.body).toContain("their words: the button is hard to see");
    expect(told).toBeDefined();
    for (const context of [
      { page: "javascript:alert(1)" },
      { commit: "--upload-pack=x" },
      "text",
    ]) {
      const refused = await tool(rw, "tell", { repo: "alice/game", text: "x", context });
      expect(refused.error).toContain("invalid");
    }
  });

  test("GET /contract/openapi.json describes the public API", async () => {
    const res = await fetch(`${base}/contract/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as any;
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/mcp"].post).toBeDefined();
  });
  test("GET /contract/openapi.json serves the triage routes", async () => {
    const doc = (await (await fetch(`${base}/contract/openapi.json`)).json()) as any;
    const R = "/api/v1/repos/{owner}/{name}";
    expect(doc.paths[`${R}/issues/{number}/teams`].get).toBeDefined();
    expect(doc.paths[`${R}/issues/{number}/teams`].put).toBeDefined();
    expect(doc.paths[`${R}/issues/{number}/labels`].put).toBeDefined();
    expect(doc.paths[`${R}/pulls/{number}/labels`].put).toBeDefined();
    expect(doc.paths[`${R}/issues/{number}/private`].post.responses["201"]).toBeDefined();
  });
  test("GET /api/v1/openapi.json redirects to the document", async () => {
    const res = await fetch(`${base}/api/v1/openapi.json`, { redirect: "manual" });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/contract/openapi.json");
    expect(res.headers.get("cache-control")).toContain("public");
    const target = await fetch(new URL(res.headers.get("location")!, base));
    expect(target.status).toBe(200);
  });
  test("feed_chips reads and switches the chips the feed answers through", async () => {
    app.bus.append({ kind: "app.serving", repoId: game.id, actorId: alice.id, payload: {} });
    const kinds = async () => {
      const r = await tool(rw, "feed", { limit: 50 });
      return (r.value.items as { kind: string }[]).map((i) => i.kind);
    };
    const api = async () => {
      const res = await fetch(`${base}/api/v1/feed?limit=50`, { headers: { authorization: `Bearer ${rw}` } });
      return ((await res.json()) as { items: { kind: string }[] }).items.map((i) => i.kind);
    };
    expect(await kinds()).toContain("release");
    expect((await tool(rw, "feed_chips")).value).toEqual({ kinds: [], people: [] });

    const set = await tool(rw, "feed_chips", { kind: "kind", value: "releases", hidden: true });
    expect(set.value).toEqual({ kinds: ["releases"], people: [] });
    expect(await kinds()).not.toContain("release");
    expect(await api()).not.toContain("release");
    // A read-only token may read the chips, not switch them.
    expect((await tool(ro, "feed_chips")).value).toEqual({ kinds: ["releases"], people: [] });
    expect((await tool(ro, "feed_chips", { kind: "kind", value: "releases", hidden: false })).error).toContain("forbidden");
    expect((await tool(rw, "feed_chips")).value.kinds).toEqual(["releases"]);

    expect((await tool(rw, "feed_chips", { kind: "kind", value: "nope", hidden: true })).error).toBeDefined();
    expect((await tool(rw, "feed_chips", { kind: "person", value: "nobody", hidden: true })).error).toBeDefined();
    expect((await tool(rw, "feed_chips", { kind: "kind", value: "crew" })).error).toBeDefined();
    const person = await tool(rw, "feed_chips", { kind: "person", value: "bob", hidden: true });
    expect(person.value).toEqual({ kinds: ["releases"], people: ["bob"] });
    await tool(rw, "feed_chips", { kind: "person", value: "bob", hidden: false });
    const back = await tool(rw, "feed_chips", { kind: "kind", value: "releases", hidden: false });
    expect(back.value).toEqual({ kinds: [], people: [] });
    expect(await kinds()).toContain("release");
  });

  test("whoami_can: the caller's role and its row, for a guest, a member and an admin", async () => {
    setMember(app.db, bob.id, false, alice.id, new Date());
    const guest = (await tool(bobRw, "whoami_can")).value;
    expect(guest.role).toBe("guest");
    expect(guest.can).toEqual({ read: true, comment: true, contribute: true, make_it_yours: false, run_crew: false, administer: false });
    setMember(app.db, bob.id, true, alice.id, new Date());
    const member = (await tool(bobRw, "whoami_can")).value;
    expect(member.role).toBe("member");
    expect(member.can).toEqual({ read: true, comment: true, contribute: true, make_it_yours: true, run_crew: true, administer: false });
    const admin = (await tool(ro, "whoami_can")).value;
    expect(admin.role).toBe("admin");
    expect(admin.can.administer).toBe(true);
  });

  test("mint_invite: an admin person with an admin token gets a link; anyone else is refused", async () => {
    const admin = createToken(app.db, alice.id, "admin", "admin").token;
    expect((await tool(bobRw, "mint_invite")).error).toContain("forbidden");
    expect((await tool(rw, "mint_invite")).error).toContain("admin token");
    expect((await tool(admin, "mint_invite", { days: 0 })).error).toContain("invalid");
    const made = (await tool(admin, "mint_invite", { days: 3 })).value;
    expect(made.link).toMatch(/\/signup\?invite=[\w-]+$/);
    const token = made.link.split("invite=")[1];
    expect(made.token).toBeUndefined();
    expect(token.length).toBeGreaterThan(20);
    const listed = await fetch(`${base}/api/v1/admin/invites`, { headers: { authorization: `Bearer ${admin}` } });
    expect(JSON.stringify(await listed.json())).toContain(made.id);
  });

  test("model_ceiling: dry by default, an admin person with an admin token sets and clears it", async () => {
    const admin = createToken(app.db, alice.id, "admin", "admin").token;
    const readOnly = createToken(app.db, alice.id, "ro", "ro").token;
    const target = (await createUser(app.db, { origin: "seed", trusted: true, username: "ceilee", email: "ceilee@forge.local", password: "a-good-passphrase" }));
    if (!target.ok) throw new Error(target.error);
    const id = target.value.id;
    const args = { username: "ceilee", dailyUsd: 12, perRunUsd: 3 };
    // A non-admin is refused.
    expect((await tool(bobRw, "model_ceiling", { ...args, dryRun: false })).error).toContain("forbidden");
    // A dry run changes nothing.
    expect((await tool(admin, "model_ceiling", args)).value.says).toContain("nothing changed");
    expect(getAccountCeiling(app.db, id)).toBeUndefined();
    // A read-only token is refused.
    expect((await tool(readOnly, "model_ceiling", { ...args, dryRun: false })).error).toContain("forbidden");
    expect(getAccountCeiling(app.db, id)).toBeUndefined();
    // Bad amounts are invalid; half a clear too.
    for (const bad of [{ dailyUsd: 0 }, { dailyUsd: 1e9 }, { perRunUsd: null }])
      expect((await tool(admin, "model_ceiling", { ...args, ...bad, dryRun: false })).error).toContain("invalid");
    expect(getAccountCeiling(app.db, id)).toBeUndefined();
    expect((await tool(admin, "model_ceiling", { ...args, dryRun: false })).value).toEqual({ username: "ceilee", dailyUsd: 12, perRunUsd: 3 });
    expect(getAccountCeiling(app.db, id)).toEqual({ dailyUsd: 12, perRunUsd: 3 });
    // Both null takes them back.
    const cleared = await tool(admin, "model_ceiling", { username: "ceilee", dailyUsd: null, perRunUsd: null, dryRun: false });
    expect(cleared.value).toEqual({ username: "ceilee", dailyUsd: null, perRunUsd: null });
    expect(getAccountCeiling(app.db, id)).toBeUndefined();
  });

  test("new_app makes an app from a sentence and apps reads it back", async () => {
    const bot = await createAgent(app, alice, { username: "newappbot", brief: "builds" });
    if (!bot.ok) throw new Error(String(bot.error));
    const made = (await tool(rw, "new_app", {
      name: "sentence",
      description: "a page that says hello",
      agent: "newappbot",
    })) as any;
    expect(made.value.repo).toBe("alice/sentence");
    expect(made.value.issue).toBe(1);
    expect(made.value.agent).toBe("newappbot");
    expect(["queued", "running", "none"]).toContain(made.value.run);
    const cardRes = await call(rw, "tools/call", { name: "new_app", arguments: { name: "carded", description: "<b>hi</b>", agent: "newappbot" } });
    const card = cardRes.body.result.structuredContent.card;
    expect(card.kind).toBe("app");
    expect(card.title).toBe("New app");
    const byLabel = (l: string) => card.rows.find((r: any) => r.label === l)?.value;
    expect(byLabel("App")).toBe("alice/carded");
    expect(byLabel("First issue")).toBe("#1");
    expect(byLabel("Agent")).toBe("newappbot");
    expect(byLabel("First run")).toBeDefined();
    const seen = (await tool(rw, "apps")) as any;
    const row = seen.value.find((r: any) => r.app === "alice/sentence");
    expect(row).toBeDefined();
    expect(row.url).toBe(made.value.url);
    // The API's refusals, in its words.
    expect((await tool(rw, "new_app", { name: "sentence" })).error).toContain("name_taken");
    expect((await tool(rw, "new_app", { name: "other", agent: "nobody-here" })).error).toContain("no_such_agent");
    // Without the rw scope nothing is made.
    const denied = await tool(ro, "new_app", { name: "readonly" });
    expect(denied.error).toContain("forbidden");
    expect((await tool(rw, "apps") as any).value.some((r: any) => r.app === "alice/readonly")).toBe(false);
  }, 30_000);

  test("new_app names an app from a sentence alone, and -2 when taken", async () => {
    const one = (await tool(rw, "new_app", { sentence: "a garden planner for my allotment" })) as any;
    expect(one.value.repo).toMatch(/^alice\/[a-z0-9-]+$/);
    expect(one.value.issue).toBe(1);
    const two = (await tool(rw, "new_app", { sentence: "a garden planner for my allotment" })) as any;
    expect(two.value.repo).toBe(`${one.value.repo}-2`);
    const named = (await tool(rw, "new_app", { name: "keepname", sentence: "a garden planner" })) as any;
    expect(named.value.repo).toBe("alice/keepname");
    expect(named.value.issue).toBe(1);
    // The derived path forwards visibility and agent, and `description` is the first issue over `sentence`.
    const bot = await createAgent(app, alice, { username: "sentbot", brief: "builds" });
    if (!bot.ok) throw new Error(String(bot.error));
    const fwd = (await tool(rw, "new_app", {
      sentence: "a recipe box for the family",
      description: "Start with a list of recipes.",
      visibility: "private",
      agent: "sentbot",
    })) as any;
    expect(fwd.value.agent).toBe("sentbot");
    const [slug] = fwd.value.repo.split("/").slice(1);
    const made = getRepo(app.db, "alice", slug)!;
    expect(made.visibility).toBe("private");
    expect(listIssues(app.db, made.id, { state: "open" })[0]!.body).toContain("Start with a list of recipes.");
    // A refusal maps as on the named path.
    expect((await tool(rw, "new_app", { sentence: "a tide table", agent: "nobody-here" })).error).toContain("no_such_agent");
    expect((await tool(rw, "new_app", { sentence: "!!!" })).error).toContain("no_name");
    expect((await tool(rw, "new_app", {})).error).toContain("no_name");
  }, 30_000);

  test("new_app with pick lets the planner name the agent", async () => {
    const picked = await createAgent(app, alice, { username: "pickbot", brief: "builds" });
    if (!picked.ok) throw new Error(String(picked.error));
    const dir = await mkdtemp(join(tmpdir(), "forge-mcp-pick-"));
    const fake = join(dir, "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
printf '%s\\n' '{"is_error":false,"result":"{\\"summary\\":\\"Build it\\",\\"checklist\\":[\\"One\\"],\\"agent\\":\\"pickbot\\",\\"confidence\\":0.8}"}'
`,
    );
    chmodSync(fake, 0o755);
    const real = process.env["FORGE_CLAUDE"];
    process.env["FORGE_CLAUDE"] = fake;
    try {
      const made = (await tool(rw, "new_app", {
        name: "picked",
        description: "a page that says hello",
        pick: true,
      })) as any;
      expect(made.error).toBeUndefined();
      expect(made.value.agent).toBe("pickbot");
      expect(typeof made.value.issue).toBe("number");
      const row = ((await tool(rw, "apps")) as any).value.find((r: any) => r.app === "alice/picked");
      expect(row.url).toBe(made.value.url);
      if (row.url !== null) expect(typeof made.value.url).toBe("string");
    } finally {
      if (real === undefined) delete process.env["FORGE_CLAUDE"];
      else process.env["FORGE_CLAUDE"] = real;
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
