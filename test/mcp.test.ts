/**
 * The forge as an MCP server: one short JSON-RPC call per answer, a token
 * and never a cookie, `ro` reads and `rw` acts, and every tool is the same
 * action the pages call — so what a person may not do on a page they may
 * not do here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { listIssues } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createRun, listRuns } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { limitChanges, limitValue } from "../src/settings/limits.ts";

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
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
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
      "apps",
      "here",
      "tell",
      "share",
      "say",
      "pull",
      "variant",
      "edit",
      "asks",
      "asks_act",
      "asks_decide",
      "asks_undecide",
      "seal",
      "now",
      "stop",
      "health",
      "audit",
      "outsiders",
      "probe",
      "following",
      "spawn",
      "forges",
      "claim_link",
      "take_updates",
      "converge",
      "next_steps",
      "asked",
      "app_members",
      "explore",
      "feed",
      "make_it_yours",
      "front_page",
      "map",
      "milestones",
      "watch",
      "limb",
      "returns",
      "spend",
      "usage",
      "link",
      "unlink",
      "attach_look",
      "hold",
      "plan",
      "capacity",
      "flow",
      "limits",
      "report",
    ]);
    const byName = new Map<string, any>(
      listed.body.result.tools.map((t: any) => [t.name, t]),
    );
    expect(byName.get("tell").annotations.readOnlyHint).toBe(false);
    expect(byName.get("tell").inputSchema.required).toEqual(["text"]);

    expect((await call(rw, "nothing/here")).body.error.code).toBe(-32601);
    expect(
      (await call(rw, "tools/call", { name: "nope" })).body.error.code,
    ).toBe(-32602);
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
    const carol = await createUser(app.db, { trusted: true,
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

  test("map, link and unlink are the plan's own actions", async () => {
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
    expect([hints.map, hints.link, hints.unlink]).toEqual([true, false, false]);

    expect(
      (await tool(rw, "link", { app: "alice/game", issue: b, blockedBy: a }))
        .value.blockedBy,
    ).toBe(a);
    const map = (await tool(ro, "map", { app: "alice/game" })).value;
    expect(map.ready.map((i: any) => i.number)).toContain(a);
    expect(map.blockedOn.map((i: any) => i.number)).toContain(a);
    expect(map.issues.find((i: any) => i.number === b).word).toBe("blocked");
    expect(map.edges).toContainEqual({ issue: b, blockedBy: a });

    // The API's words, for a loop, a stranger issue, and a read token.
    expect(
      (await tool(rw, "link", { app: "alice/game", issue: a, blockedBy: b }))
        .error,
    ).toBe("cycle: that would make a loop");
    expect(
      (await tool(rw, "link", { app: "alice/game", issue: a, blockedBy: 999 }))
        .error,
    ).toBe("no_such_issue: no issue #999");
    expect(
      (await tool(ro, "link", { app: "alice/game", issue: a, blockedBy: b }))
        .error,
    ).toContain("forbidden");
    // A private app is no such app to someone who cannot read it.
    expect((await tool(bobRw, "map", { app: "alice/game" })).error).toContain(
      "not_found",
    );
    expect(
      (await tool(bobRw, "link", { app: "alice/game", issue: b, blockedBy: a }))
        .error,
    ).toContain("not_found");

    await tool(rw, "unlink", { app: "alice/game", issue: b, blockedBy: a });
    const after = (await tool(ro, "map", { app: "alice/game" })).value;
    expect(after.edges).not.toContainEqual({ issue: b, blockedBy: a });
    expect(after.ready.map((i: any) => i.number)).toContain(b);
  });

  test("plan opens linked issues all or none", async () => {
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
          { line: "a", kind: "look", items: ["x:1"], words: {} },
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
        for (const f of t.inputSchema.required ?? []) {
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
});
