/** `org_teams { waiting: true }` lists the open pulls a crew team's review holds, for readers only. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { nameTeams } from "../src/actions/issue_teams.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { pullsWaitingOn } from "../src/actions/issue_teams.ts";
import { createApp, type App } from "../src/app.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { createOrg } from "../src/core/orgs.ts";
import type { Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { saveTeam } from "../src/core/teams.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { seatAs } from "./helpers/seat.ts";

quietLogs();

describe("MCP org_teams waiting", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let aliceTok: string;
  let bobTok: string;
  let pub: Repo;
  let priv: Repo;
  let id = 1;
  let n = 0;

  const call = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: id++,
        method: "tools/call",
        params: { name: "org_teams", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    if (body.error) return { text: String(body.error.message), isError: true };
    return { text: body.result.content[0].text as string, isError: body.result.isError === true };
  };
  const waiting = async (token: string) => {
    const r = await call(token, { org: "acme", team: "design", waiting: true });
    expect(r.isError).toBe(false);
    return JSON.parse(r.text).items as { repo: string; number: number; title: string; since: string }[];
  };

  const pullIn = async (repo: Repo, title: string) => {
    const issue = openIssue(app, alice, repo, { title });
    if (!issue.ok) throw new Error(issue.error);
    const set = nameTeams(app, alice, repo, issue.value, ["design"]);
    if (!set.ok) throw new Error(set.error);
    const branch = `w${++n}`;
    const c = await commitToBranch(app, alice, repo, {
      branch,
      base: "main",
      message: branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const o = await openPull(app, alice, repo, {
      title,
      body: `Closes #${issue.value.number}`,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-waiting-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    alice = await mk("alice");
    const bob = await mk("bob");
    aliceTok = createToken(app.db, alice.id, "admin", "admin").token;
    bobTok = createToken(app.db, bob.id, "admin", "admin").token;
    const org = createOrg(app.db, "acme", alice.id);
    if (!org.ok) throw new Error(org.error);
    for (const [name, visibility] of [["open", "public"], ["secret", "private"]] as const) {
      const r = await createRepo(app, alice, { name, visibility });
      if (!r.ok) throw new Error(String(r.error));
      const seeded = await commitToBranch(app, alice, r.value, {
        message: "seed",
        files: [{ path: "README.md", content: "# x\n" }],
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
      if (name === "open") pub = r.value;
      else priv = r.value;
    }
    const agent = await createAgent(app, alice, { username: "quill" });
    if (!agent.ok) throw new Error(String(agent.error));
    const quill = getUserByName(app.db, "quill")!;
    for (const r of [pub, priv]) {
      addToCrew(app, alice, r, "quill");
      seatAs(app.db, r.id, quill.id, "reviewer");
    }
    saveTeam(app.db, "design", { charter: "", dial: 0, members: [quill.id] });
  }, 120_000);

  afterAll(async () => {
    servers.stop();
    for (let i = 0; i < 20; i++) await new Promise((done) => setImmediate(done));
    await Bun.sleep(100);
    app?.close();
    if (dataDir !== "") await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }, 30_000);

  test("a held pull is listed, an approved one is not, a private one is hidden from a non-reader", async () => {
    const held = await pullIn(pub, "Held chart");
    const done = await pullIn(pub, "Approved chart");
    const hidden = await pullIn(priv, "Secret chart");
    submitReview(app.db, {
      issueId: done.id,
      authorId: getUserByName(app.db, "quill")!.id,
      state: "approved",
      commitOid: done.headOid,
    });
    const mine = await waiting(aliceTok);
    expect(mine.map((i) => [i.repo, i.number, i.title])).toEqual([
      ["alice/open", held.number, "Held chart"],
      ["alice/secret", hidden.number, "Secret chart"],
    ]);
    expect(typeof mine[0]!.since).toBe("string");
    const theirs = await waiting(bobTok);
    expect(theirs.map((i) => i.title)).toEqual(["Held chart"]);
  });

  test("oldest first by when the pull was opened, not by query order", async () => {
    const older = await pullIn(pub, "Opened first, listed by age");
    app.db.query("UPDATE issue SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1").run(older.id);
    const items = await waiting(aliceTok);
    expect(items[0]!.title).toBe("Opened first, listed by age");
    const sinces = items.map((i) => i.since);
    expect([...sinces].sort()).toEqual(sinces);
    expect(sinces.length).toBeGreaterThan(2);
  });

  test("the answer stops at its cap", () => {
    const got = pullsWaitingOn(app, alice, "design", 2);
    expect(got.ok && got.value.length).toBe(2);
    const all = pullsWaitingOn(app, alice, "design");
    expect(all.ok && all.value.length).toBeGreaterThan(2);
  });

  test("a token without admin scope is refused", async () => {
    const rw = createToken(app.db, alice.id, "rw", "rw").token;
    const r = await call(rw, { org: "acme", team: "design", waiting: true });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("Held chart");
  });

  test("the crew-teams screen lists them on w, for the same reader", async () => {
    const terminal = headlessTerminal(140, 32);
    const { app: tui } = createForgeApp(
      app,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user: alice },
      { terminal, exitHooks: false },
    );
    tui.start();
    const press = async (...keys: string[]) => {
      for (const key of keys) tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(tui);
    };
    tui.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
    await settleApp(tui);
    for (const ch of "Crew teams") tui.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
    await settleApp(tui);
    await press("enter", "w");
    const text = tui.screen.toText();
    expect(text).toContain("Held chart");
    expect(text).toContain("alice/open#");
    tui.stop();
  });

  test("an unknown team is not found", async () => {
    const r = await call(aliceTok, { org: "acme", team: "nope", waiting: true });
    expect(r.isError).toBe(true);
  });
});
