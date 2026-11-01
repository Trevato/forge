/**
 * A report carries who filed it (#7658): an account a token proved, a name
 * claimed without one — shown as a claim — or nobody, said as anonymous.
 * The owner reads the waiting reports grouped by filer with a count, and a
 * stranger's words stay `untrusted`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/actions/crew.ts";
import { acceptReport } from "../src/actions/reports.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getIssue } from "../src/core/issues.ts";
import {
  byFiler,
  claimOf,
  filerWords,
  getReport,
  insertReport,
  listWaiting,
  type Report,
} from "../src/core/reports.ts";
import type { Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Ctx } from "../src/http/context.ts";
import { proofOf } from "../src/http/report_filer.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("attributed reports", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceToken: string;
  let museToken: string;
  let source = 0;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-reports-attributed-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error(a.error);
    const made = await createRepo(app, a.value, { name: "game", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    // muse is an outside agent: on no crew, so it writes nothing here.
    const muse = await createAgent(app, a.value, { username: "muse" });
    if (!muse.ok) throw new Error(String(muse.error));
    aliceToken = createToken(app.db, a.value.id, "t", "rw").token;
    museToken = createToken(app.db, muse.value.user.id, "t", "rw").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const file = (payload: Record<string, unknown>, token?: string) =>
    fetch(`${servers.url}/api/v1/repos/alice/game/reports`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": `198.51.100.${++source}`,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });

  const mcp = async (name: string, args: unknown, token?: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-forwarded-for": `198.51.100.${++source}`,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name, arguments: args } }),
    });
    const body: any = await res.json();
    return JSON.parse(body.result.content[0].text);
  };

  test("a report filed with a token carries its account; a claim beside it is dropped", async () => {
    const res = await file({ title: "Stuck on the login page", agent: "someone-else" }, museToken);
    expect(res.status).toBe(202);
    expect(((await res.json()) as any).filedBy).toEqual({ how: "signed", name: "muse" });
    const viaMcp = await mcp("report", { repo: "alice/game", title: "Cannot find the API" }, museToken);
    expect(viaMcp.state).toBe("pending");
  });

  test("a name given without a token is a claim; none at all is anonymous", async () => {
    const claimed = await file({ title: "Search hangs", agent: "grokbot" });
    expect(((await claimed.json()) as any).filedBy).toEqual({ how: "claimed", name: "grokbot" });
    const anon = await file({ title: "Typo on home" });
    expect(((await anon.json()) as any).filedBy).toEqual({ how: "anonymous", name: null });
    // A claim cannot dress up as an account (no @) or carry markup.
    expect((await file({ title: "x", agent: "@muse" })).status).toBe(422);
    expect((await file({ title: "x", agent: "<b>muse</b>" })).status).toBe(422);
  });

  test("the API lists each report's filer, untrusted, with counts by agent", async () => {
    const res = await fetch(`${servers.url}/api/v1/repos/alice/game/reports`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    const listed: any = await res.json();
    const signed = listed.items.filter((r: any) => r.filedBy.how === "signed");
    expect(signed.map((r: any) => r.filedBy.name)).toEqual(["muse", "muse"]);
    const anon = listed.items.find((r: any) => r.title === "Typo on home");
    expect(anon.filedBy).toEqual({ how: "anonymous", name: null });
    expect(listed.items.every((r: any) => r.untrusted === true)).toBe(true);
    expect(listed.items.some((r: any) => "filerId" in r)).toBe(false);
    expect(listed.byAgent).toEqual([
      { how: "signed", name: "muse", count: 2 },
      { how: "claimed", name: "grokbot", count: 1 },
      { how: "anonymous", name: null, count: 1 },
    ]);
  });

  test("the MCP `reports` tool groups by agent and says so", async () => {
    const listed = await mcp("reports", { repo: "alice/game" }, aliceToken);
    expect(listed.byAgent[0]).toEqual({ how: "signed", name: "muse", count: 2 });
    expect(listed.says).toContain("2 @muse");
    expect(listed.says).toContain("1 claims to be grokbot, unproven");
    expect(listed.says).toContain("1 anonymous");
    expect(listed.items.every((r: any) => r.untrusted === true)).toBe(true);
  });

  test("the reports page groups by filer with a count and marks a claim", async () => {
    const page = await (
      await fetch(`${servers.url}/alice/game/reports`, {
        headers: { authorization: `Bearer ${aliceToken}` },
      })
    ).text();
    expect(page).toContain("<h2>@muse · 2</h2>");
    expect(page).toContain("“grokbot”, claimed without a token · 1");
    expect(page).toContain("<h2>Anonymous · 1</h2>");
    expect(page).toContain("From outside, anonymous, not checked");
    // The anonymous report claims no one.
    const anonCard = page.slice(page.indexOf("<h2>Anonymous"));
    expect(anonCard).not.toContain("@muse");
  });

  test("a writer's own report is not marked untrusted", async () => {
    expect((await file({ title: "Note to self" }, aliceToken)).status).toBe(202);
    const listed: any = await (
      await fetch(`${servers.url}/api/v1/repos/alice/game/reports`, {
        headers: { authorization: `Bearer ${aliceToken}` },
      })
    ).json();
    const own = listed.items.find((r: any) => r.title === "Note to self");
    expect(own.filedBy).toEqual({ how: "signed", name: "alice" });
    expect(own.untrusted).toBeUndefined();
  });
});

describe("proof of the filer", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let game: Repo;
  let cookie: string;
  let source = 0;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-reports-proof-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, { name: "game", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    game = made.value;
    cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const post = (path: string, type: string, payload: string, headers: Record<string, string>) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": type, "x-forwarded-for": `203.0.113.${++source}`, ...headers },
      body: payload,
    });
  const api = (payload: object, headers: Record<string, string>) =>
    post("/api/v1/repos/alice/game/reports", "application/json", JSON.stringify(payload), headers);
  const filedBy = async (res: Response) => {
    expect(res.status).toBe(202);
    return ((await res.json()) as any).filedBy;
  };

  test("a cookie on a cross-site API POST files nothing in anyone's name", async () => {
    // The floor refuses it before the route runs; nothing is stored.
    const refused = await api({ title: "Cross-site" }, { cookie, origin: "https://evil.example" });
    expect(refused.status).toBe(403);
    expect(listWaiting(app.db, game.id).some((r) => r.title === "Cross-site")).toBe(false);
    // A cookie without this forge's Origin proves no one.
    expect(await filedBy(await api({ title: "x" }, { cookie }))).toEqual({ how: "anonymous", name: null });
    expect(await filedBy(await api({ title: "x", agent: "muse" }, { cookie }))).toEqual({
      how: "claimed",
      name: "muse",
    });
  });

  test("proofOf: a token or password always; a cookie only with this forge's Origin", () => {
    const ctx = (via: string, origin?: string) =>
      ({
        auth: { user: alice, via, scope: undefined },
        url: new URL("https://forge.test/x"),
        request: new Request("https://forge.test/x", {
          method: "POST",
          headers: origin === undefined ? {} : { origin },
        }),
      }) as unknown as Ctx;
    expect(proofOf(ctx("token"))).toBe(alice);
    expect(proofOf(ctx("password", "https://evil.example"))).toBe(alice);
    expect(proofOf(ctx("session", "https://forge.test"))).toBe(alice);
    expect(proofOf(ctx("edge", "https://forge.test"))).toBe(alice);
    expect(proofOf(ctx("session", "https://evil.example"))).toBeUndefined();
    expect(proofOf(ctx("session"))).toBeUndefined();
    expect(proofOf(ctx("session", "null"))).toBeUndefined();
    expect(proofOf(ctx("none", "https://forge.test"))).toBeUndefined();
  });

  test("a cookie from this forge's own page proves the account", async () => {
    expect(await filedBy(await api({ title: "x" }, { cookie, origin: servers.url }))).toEqual({
      how: "signed",
      name: "alice",
    });
  });

  test("the form says whose a report will be, and a signed-in POST from it is signed", async () => {
    const signedIn = await (await fetch(`${servers.url}/alice/game/report`, { headers: { cookie } })).text();
    expect(signedIn).toContain("Sent as @alice");
    const stranger = await (await fetch(`${servers.url}/alice/game/report`)).text();
    expect(stranger).toContain("Sent anonymously");
    expect(stranger).not.toContain("Sent as @");

    const form = "title=From+the+form&body=&page=";
    const sent = await post("/alice/game/report", "application/x-www-form-urlencoded", form, {
      cookie,
      origin: servers.url,
    });
    expect(sent.status).toBe(303);
    const waiting: any = await (
      await fetch(`${servers.url}/api/v1/repos/alice/game/reports`, { headers: { cookie } })
    ).json();
    const mine = waiting.items.find((r: any) => r.title === "From the form");
    expect(mine.filedBy).toEqual({ how: "signed", name: "alice" });
    // The form refuses a foreign page before anything is filed.
    const refused = await post("/alice/game/report", "application/x-www-form-urlencoded", form, {
      cookie,
      origin: "https://evil.example",
    });
    expect(refused.status).toBe(403);
  });

  test("an accepted report's issue names its filer, a claim as a claim", async () => {
    const signed = insertReport(app.db, game.id, { title: "Signed one", body: "b", page: null }, alice.id);
    const claimed = insertReport(app.db, game.id, { title: "Claimed one", body: "b", page: null, claimed: "muse" });
    const anon = insertReport(app.db, game.id, { title: "Anon one", body: "b", page: null });
    const body = async (id: string) => {
      const done = await acceptReport(app, alice, game, id);
      if (!done.ok) throw new Error(String(done.error));
      return getIssue(app.db, game.id, done.value.number)!.body;
    };
    expect(await body(signed.id)).toStartWith("Reported from outside, by @alice, ");
    expect(await body(claimed.id)).toStartWith("Reported from outside, by claims to be muse, unproven, ");
    expect(await body(anon.id)).toStartWith("Reported from outside, without an account, ");
  });

  test("a row from before the migration reads anonymous; deleting the filer makes it anonymous", async () => {
    app.db
      .query("INSERT INTO report (id, repo_id, title, body, page) VALUES ('old-row', ?1, 'Old', '', NULL)")
      .run(game.id);
    expect(getReport(app.db, game.id, "old-row")!.filedBy).toEqual({ how: "anonymous", name: null });

    const d = await createUser(app.db, { origin: "seed", trusted: true,
      username: "dora", email: "dora@forge.local", password: "a-good-passphrase" });
    if (!d.ok) throw new Error(d.error);
    const r = insertReport(app.db, game.id, { title: "Dora's", body: "", page: null }, d.value.id);
    expect(r.filedBy).toEqual({ how: "signed", name: "dora" });
    app.db.query("DELETE FROM user WHERE id = ?1").run(d.value.id);
    const after = getReport(app.db, game.id, r.id)!;
    expect(after.filerId).toBeNull();
    expect(after.filedBy).toEqual({ how: "anonymous", name: null });
  });
});

describe("byFiler", () => {
  const r = (how: "signed" | "claimed" | "anonymous", name: string | null): Report => ({
    id: "r", repoId: "p", title: "t", body: "", page: null, state: "pending",
    createdAt: "2026-11-01T00:00:00.000Z", filedBy: { how, name }, filerId: null,
  });

  test("a signed name and the same name claimed are two groups, most first", () => {
    expect(
      byFiler([r("claimed", "muse"), r("anonymous", null), r("signed", "muse"), r("anonymous", null)]),
    ).toEqual([
      { how: "anonymous", name: null, count: 2 },
      { how: "signed", name: "muse", count: 1 },
      { how: "claimed", name: "muse", count: 1 },
    ]);
  });

  test("a claim is a name's shape or nothing", () => {
    expect(claimOf("  ")).toEqual({ ok: true, value: null } as any);
    expect(claimOf("grok.bot_2").ok).toBe(true);
    expect(claimOf("a".repeat(65)).ok).toBe(false);
    expect(filerWords({ how: "anonymous", name: null })).toBe("anonymous");
  });
});