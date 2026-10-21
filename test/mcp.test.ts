/**
 * The forge as an MCP server: one short JSON-RPC call per answer, a token
 * and never a cookie, `ro` reads and `rw` acts, and every tool is the same
 * action the pages call — so what a person may not do on a page they may
 * not do here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { pullDir } from "../src/core/pulls.ts";
import { resolveOid } from "../src/git/merge.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { addComment, createIssue, listIssues } from "../src/core/issues.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { getRepoById, updateRepoSettings, type Repo } from "../src/core/repos.ts";
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

    const listed = await call(rw, "tools/list");
    const names = listed.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([
      "sizes",
      "apps",
      "new_app",
      "repo",
      "here",
      "tell",
      "share",
      "say",
      "issue",
      "pull",
      "variant",
      "edit",
      "read_file",
      "asks",
      "asks_act",
      "asks_decide",
      "asks_proposal",
      "proposal_tokens",
      "asks_undecide",
      "seal",
      "issue_teams",
      "now",
      "stop",
      "health",
      "audit",
      "model_grant",
      "whoami_can",
      "mint_invite",
      "account_role",
      "model_ceiling",
      "outsiders",
      "decisions_by",
      "archive",
      "branches",
      "commits",
      "probe",
      "following",
      "spawn",
      "forges",
      "claim_link",
      "take_updates",
      "sever",
      "follow_mode",
      "propose_to_parent_forge",
      "forge_proposals",
      "converge",
      "family",
      "next_steps",
      "thought",
      "asked",
      "app_members",
      "explore",
      "search",
      "feed",
      "feed_chips",
      "make_it_yours",
      "front_page",
      "map",
      "milestones",
      "watch",
      "runs",
      "run_log",
      "limb",
      "returns",
      "review",
      "spend",
      "usage",
      "labels",
      "wait_for",
      "attach_look",
      "hold",
      "plan",
      "access",
      "capacity",
      "scorecard",
      "flow",
      "system",
      "contribute",
      "limits",
      "teams",
      "cloud_accounts",
      "cloud_account",
      "quotas",
      "signup",
      "boards",
      "board_write",
      "board_pins",
      "board_delete",
      "report",
    ]);
    const byName = new Map<string, any>(
      listed.body.result.tools.map((t: any) => [t.name, t]),
    );
    expect(byName.get("tell").annotations.readOnlyHint).toBe(false);
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
    expect((await tool(rw, "issue", { repo: "alice/game", number: opened.value.number })).error).toContain("not_found");

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
    const listed = await call(ro, "tools/list");
    const hints = Object.fromEntries(
      listed.body.result.tools.map((t: any) => [
        t.name,
        t.annotations.readOnlyHint,
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
    const listed = await call(rw, "tools/list");
    const hints = Object.fromEntries(
      listed.body.result.tools.map((t: any) => [
        t.name,
        t.annotations.readOnlyHint,
      ]),
    );
    expect([hints.map, hints.wait_for]).toEqual([true, false]);

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
  });

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
      "ui://forge/decision",
      "ui://forge/run",
      "ui://forge/wave",
    ]);
    const read = await call(rw, "resources/read", { uri: "ui://forge/app" });
    const c = read.body.result.contents[0];
    expect(c.mimeType).toBe("text/html;profile=mcp-app");
    expect(c.text).toContain("ui/notifications/tool-result");
    expect(c.text).not.toContain("innerHTML");
    const nope = await call(rw, "resources/read", { uri: "ui://forge/nope" });
    expect(nope.body.error.code).toBe(-32002);
    const tools = (await call(rw, "tools/list")).body.result.tools;
    const meta = (n: string) => tools.find((t: any) => t.name === n)._meta?.ui?.resourceUri;
    expect(meta("apps")).toBe("ui://forge/app");
    expect(meta("new_app")).toBe("ui://forge/app");
    expect(meta("now")).toBe("ui://forge/run");
    expect(meta("asks")).toBe("ui://forge/decision");
    expect(meta("milestones")).toBe("ui://forge/wave");
  });

  test("a tool result carries the card it renders", async () => {
    const { body } = await call(rw, "tools/call", { name: "apps", arguments: {} });
    const card = body.result.structuredContent.card;
    expect(card.kind).toBe("app");
    expect(card.rows.some((r: any) => r.label === "alice/game")).toBe(true);
    const asks = await call(rw, "tools/call", { name: "asks", arguments: {} });
    expect(asks.body.result.structuredContent.card.kind).toBe("decision");
  });

  test("ship and close card actions never apply at once and always meet the target tool's required fields", async () => {
    const { cardFor } = await import("../src/web/studio/cards.ts");
    const tools = (await call(rw, "tools/list")).body.result.tools;
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
      for (const a of card!.actions) {
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
    expect(guest.can).toEqual({ read: true, comment: true, make_it_yours: false, run_crew: false, administer: false });
    setMember(app.db, bob.id, true, alice.id, new Date());
    const member = (await tool(bobRw, "whoami_can")).value;
    expect(member.role).toBe("member");
    expect(member.can).toEqual({ read: true, comment: true, make_it_yours: true, run_crew: true, administer: false });
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
