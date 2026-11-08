/**
 * The week's doors (#8704): the page, MCP and the terminal share one
 * `takeProposal`, so a proposal is taken by a person who writes and by no one
 * else, once; the cut line is drawn once capacity is read; and pricing a list
 * or writing a retrospective spends no agent run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { createRepo } from "../src/actions/repos.ts";
import { WEEK_FORBIDDEN, WEEK_PERSON, takeProposal } from "../src/actions/week.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { getIssue } from "../src/core/issues.ts";
import { nextUp } from "../src/core/next_up.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { noteLimit } from "../src/core/standing.ts";
import { addSubscription } from "../src/core/subscriptions.ts";
import { createToken } from "../src/core/tokens.ts";
import { recordUsage } from "../src/core/usage.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { latestRetro, takenOf, tickWeeks, failureClass } from "../src/flow/retro.ts";
import { CUT_TOP_WORDS, cutLine, cutWords, FIT_COUNT_JS, rowCosts, weekView } from "../src/flow/week.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { KEYS_JS } from "../src/web/pages/next.ts";
import { Window } from "happy-dom";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("the week's doors", () => {
  let dataDir: string;
  let forge: Forge;
  let servers: Servers;
  let base: string;
  let alice: User;
  let bob: User;
  let bot: User;
  let repo: Repo;
  let aliceCookie = "";
  let bobCookie = "";
  let aliceTok = "";
  let botTok = "";
  const n: Record<string, number> = {};
  const day = 86_400_000;

  const open = (title: string): number => {
    const o = openIssue(forge, alice, repo, { title });
    if (!o.ok) throw new Error(String(o.error));
    return o.value.number;
  };
  const runRows = (): number => forge.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM run").get()!.n;
  const spend = (number: number, usd: number, state: string, at: string, summary = "") =>
    forge.db
      .query(
        `INSERT INTO run (id, repo_id, kind, issue_id, state, cost_usd, started_at, summary)
         VALUES (lower(hex(randomblob(8))), ?1, 'agent', ?2, ?3, ?4, ?5, ?6)`,
      )
      .run(repo.id, getIssue(forge.db, repo.id, number)!.id, state, usd, at, summary);
  const signIn = async (username: string): Promise<string> => {
    const res = await fetch(`${base}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  const mcp = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "week", arguments: args } }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };
  const post = (headers: Record<string, string>, idx = 0) =>
    fetch(`${base}/alice/plan/week`, {
      method: "POST",
      headers: { accept: "application/json", ...headers },
      body: new URLSearchParams({ week_end: latestRetro(forge.db, repo.id)!.weekEnd, idx: String(idx) }),
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-week-doors-"));
    forge = createApp({ dataDir, port: 0 });
    servers = await serve(forge);
    base = `http://127.0.0.1:${servers.port}`;
    for (const [username, first] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(forge.db, {
        origin: "seed", trusted: true, username, email: `${username}@forge.local`,
        password: "a-good-passphrase", adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
    }
    alice = getUserByName(forge.db, "alice")!;
    bob = getUserByName(forge.db, "bob")!;
    const made = await createRepo(forge, alice, { name: "plan", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const agent = await createAgent(forge, alice, { username: "bot" });
    if (!agent.ok) throw new Error(String(agent.error));
    bot = agent.value.user;
    if (!addToCrew(forge, alice, repo, "bot").ok) throw new Error("crew");
    botTok = createToken(forge.db, bot.id, "rw", "rw").token;
    aliceTok = createToken(forge.db, alice.id, "rw", "rw").token;

    n.gate = open("Later gate: not now");
    const past = new Date(Date.now() - 3 * day).toISOString();
    for (const usd of [1, 2, 3, 4, 5]) {
      const done = open(`Past ${usd}`);
      spend(done, usd, "ok", past);
      const r = setIssueState(forge, alice, repo, getIssue(forge.db, repo.id, done)!, "closed");
      if (!r.ok) throw new Error(String(r.error));
    }
    n.stuck = open("Stuck one");
    for (let i = 0; i < 6; i++) open(`Work ${i}`);
    for (let i = 0; i < 3; i++) spend(n.stuck, 3, "failed", new Date(Date.now() - 2 * day).toISOString(), "secret token sk-123 leaked in the check output");

    n.costly = open("Costly one");
    spend(n.costly, 4, "ok", new Date(Date.now() - 2 * day).toISOString());
    // Capacity: the provider refused at $20 a week ago; the next window is open and unspent.
    const sub = addSubscription(forge.db, dataDir, { name: "acct", token: "sk-ant-oat01-doors-test-1" });
    if (!sub.ok) throw new Error(sub.error);
    recordUsage(forge.db, {
      runId: createRun(forge.db, { repoId: repo.id, kind: "agent" }).id, repoId: repo.id, issueId: null, agentId: null,
      subscriptionId: sub.value.id, tokensIn: 1, tokensOut: 1, costUsd: 20, wallMs: 1000, outcome: "ok",
      at: new Date(Date.now() - 8.5 * day).toISOString(),
    });
    noteLimit(forge.db, sub.value.id, {
      window: "week", resetsAt: new Date(Date.now() - 2 * day).toISOString(),
      observedAt: new Date(Date.now() - 8 * day).toISOString(), said: "weekly limit",
    });
    aliceCookie = await signIn("alice");
    bobCookie = await signIn("bob");
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the rows carry their cost and the list the capacity, and the client rule places the same line as weekView", async () => {
    const rows = nextUp(forge.db, repo).rows;
    const view = weekView(forge.db, repo.id, rows, new Date());
    const page = await (await fetch(`${base}/alice/plan/next`, { headers: { cookie: aliceCookie } })).text();
    const doc = new Window().document;
    doc.body.innerHTML = page;
    const list = doc.getElementById("next-list")!;
    const capacity = Number(list.getAttribute("data-capacity"));
    expect(capacity).toBe(view.capacity!.usd);
    const lis = [...list.querySelectorAll("li[data-number]")];
    expect(lis.length).toBe(Math.min(10, rows.length));
    const costs = lis.map((li) => Number(li.getAttribute("data-cost")));
    expect(costs.every((c) => Number.isFinite(c) && c >= 0)).toBe(true);
    const fitCount = new Function(`${FIT_COUNT_JS}; return fitCount;`)() as (c: number[], usd: number) => number;
    expect(fitCount(costs, capacity)).toBe(view.cut.fits.length);
    // Reranked, both sides read the same costs: the full reversed list, one median.
    const reversed = [...view.priced].reverse();
    expect(fitCount(rowCosts(reversed)!, capacity)).toBe(cutLine(reversed, view.capacity).fits.length);
  });

  test("with no line drawn the list carries no capacity", async () => {
    const page = await (await fetch(`${base}/alice/plan/next`, { headers: { cookie: aliceCookie } })).text();
    const without = page.replace(/ data-capacity="[^"]*"/, "");
    expect(without).not.toContain("data-capacity");
    // The server and the script say the same sentences.
    expect(KEYS_JS).toContain(JSON.stringify(CUT_TOP_WORDS));
    expect(KEYS_JS).toContain(JSON.stringify(cutWords("{n}")));
  });

  test("dragging a row moves the line before any save, and a refusal puts it back", async () => {
    const page = await (await fetch(`${base}/alice/plan/next`, { headers: { cookie: aliceCookie } })).text();
    for (const accept of [true, false]) {
      const window = new Window();
      const doc = window.document;
      doc.body.innerHTML = page;
      const list = doc.getElementById("next-list")!;
      const order = () => [...list.children].map((c) => c.getAttribute("data-number") ?? "|");
      const before = order();
      const posted: string[] = [];
      let reloaded = false;
      const fetcher = async (_u: string, init: { body: URLSearchParams }) => {
        posted.push(init.body.toString());
        return { ok: accept, json: async () => ({ error: "no" }) };
      };
      const location = { pathname: "/alice/plan/next", reload: () => { reloaded = true; } };
      const store = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
      new Function("document", "sessionStorage", "fetch", "location", "FormData", KEYS_JS)(doc, store, fetcher, location, window.FormData);
      const lis = [...list.querySelectorAll("li[data-number]")];
      const fire = (el: { dispatchEvent(e: unknown): boolean }, type: string) => el.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
      fire(lis[0]!, "dragstart");
      fire(lis[lis.length - 1]!, "dragover");
      // Before the save: the row sits last and the line was re-placed for the new order.
      expect(list.querySelectorAll("li[data-number]")[lis.length - 1]).toBe(lis[0]!);
      expect(list.querySelectorAll(".cut-line").length).toBeLessThanOrEqual(1);
      expect(posted).toHaveLength(0);
      fire(lis[lis.length - 1]!, "drop");
      await new Promise((r) => setTimeout(r, 10));
      fire(lis[0]!, "dragend");
      expect(posted).toHaveLength(1);
      if (accept) {
        expect(reloaded).toBe(true);
        expect(order()).not.toEqual(before);
      } else {
        expect(reloaded).toBe(false);
        expect(order()).toEqual(before);
      }
    }
  });

  test("once capacity is read, Next up draws the cut line and the rows below read as next week", async () => {
    const view = weekView(forge.db, repo.id, nextUp(forge.db, repo).rows, new Date());
    expect(view.cut.unsure).toBeNull();
    expect(view.cut.fits.length).toBeGreaterThan(0);
    expect(view.cut.fits.length).toBeLessThan(nextUp(forge.db, repo).rows.length);
    const page = await (await fetch(`${base}/alice/plan/next`, { headers: { cookie: aliceCookie } })).text();
    expect(page.match(/role="separator"/g)).toHaveLength(1);
    expect(page).toContain(`This week ends here (${view.cut.fits.length} fit)`);
    expect(page).toContain("should ship by");
    // The terminal draws the same line and the same ranges.
    const terminal = headlessTerminal(140, 40);
    const { app } = createForgeApp(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user: alice }, { terminal, exitHooks: false });
    app.start();
    const key = async (...keys: string[]) => {
      for (const k of keys) app.dispatch({ type: "key", key: k, ctrl: k === "ctrl+k" ? false : false, alt: false, shift: false });
      await settleApp(app);
    };
    app.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
    await settleApp(app);
    for (const ch of "Next up in a repository") app.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
    await key("enter");
    for (const ch of "alice/plan") app.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
    await key("enter");
    expect(terminal && app.screen.toText()).toContain("this week ends here");
    expect(app.screen.toText()).toContain("$");
    app.stop();
  });

  test("pricing, projecting and writing a retrospective spend no agent run", async () => {
    const before = runRows();
    weekView(forge.db, repo.id, nextUp(forge.db, repo).rows, new Date());
    await fetch(`${base}/alice/plan/next`, { headers: { cookie: aliceCookie } });
    // The window that ended two days ago had its projection stored; the tick closes it.
    const open = nextUp(forge.db, repo).rows;
    forge.db
      .query("INSERT INTO week_projection (repo_id, week_end, body, at) VALUES (?1, ?2, ?3, ?4)")
      .run(repo.id, new Date(Date.now() - day).toISOString(), JSON.stringify({ sentence: "s", fits: [], shipLow: 0, shipHigh: 1, confidence: "low", ranges: {} }), new Date(Date.now() - 8 * day).toISOString());
    expect(open.length).toBeGreaterThan(0);
    expect(tickWeeks(forge.db, [repo], new Date())).toHaveLength(1);
    expect(runRows()).toBe(before);
  });

  test("a stuck reason is a failure class, never the run's own words", () => {
    const retro = latestRetro(forge.db, repo.id)!;
    const stuck = retro.stuck.find((s) => s.number === n.stuck)!;
    expect(stuck.why).toContain("3 failed runs");
    expect(JSON.stringify(retro)).not.toContain("sk-123");
    expect(failureClass("the check failed")).toBe("its check failed");
    expect(failureClass("whatever else")).toBe("ended without finishing");
  });

  test("a sealed issue's cost does not shape visible ranges", () => {
    const before = weekView(forge.db, repo.id, nextUp(forge.db, repo).rows, new Date()).priced;
    const s = openIssue(forge, alice, repo, { title: "Sealed" });
    if (!s.ok) throw new Error(String(s.error));
    spend(s.value.number, 900, "ok", new Date().toISOString());
    forge.db.query("UPDATE issue SET state = 'closed', close_reason = 'done', closed_at = ?2 WHERE id = ?1").run(s.value.id, new Date().toISOString());
    forge.db.query("UPDATE issue SET sealed = 1 WHERE id = ?1").run(s.value.id);
    expect(weekView(forge.db, repo.id, nextUp(forge.db, repo).rows, new Date()).priced).toEqual(before);
  });

  test("takeProposal refuses a reader and an agent, with their own words, and takes nothing", () => {
    const retro = latestRetro(forge.db, repo.id)!;
    expect(retro.proposals.length).toBeGreaterThan(0);
    const reader = takeProposal(forge, bob, repo, retro.weekEnd, 0);
    expect(reader.ok).toBe(false);
    if (!reader.ok) expect(reader.error.message).toBe(WEEK_FORBIDDEN);
    const agent = takeProposal(forge, bot, repo, retro.weekEnd, 0);
    expect(agent.ok).toBe(false);
    if (!agent.ok) expect(agent.error.message).toBe(WEEK_PERSON);
    expect(takenOf(forge.db, repo.id, retro.weekEnd).size).toBe(0);
  });

  test("POST /week: no cookie, another origin, a reader and an agent are refused", async () => {
    const same = { origin: base };
    expect((await post({ ...same })).status).not.toBe(200);
    expect((await post({ cookie: aliceCookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ cookie: bobCookie, ...same })).status).toBe(422);
    expect((await post({ authorization: `Bearer ${botTok}`, ...same })).status).toBe(422);
    expect(takenOf(forge.db, repo.id, latestRetro(forge.db, repo.id)!.weekEnd).size).toBe(0);
  });

  test("MCP week: an agent is refused; a person takes a proposal once", async () => {
    const refused = await mcp(botTok, { app: "alice/plan", take: 0 });
    expect(refused.error).toContain("forbidden");
    const read = await mcp(botTok, { app: "alice/plan" });
    expect(read.value.proposals[0].taken).toBe(false);
    expect(read.value.polish).toMatchObject({ share: 10, under: true, polishUsd: 0 });
    const took = await mcp(aliceTok, { app: "alice/plan", take: 0 });
    expect(took.value.proposals[0].taken).toBe(true);
    expect((await mcp(aliceTok, { app: "alice/plan", take: 0 })).error).toContain("already taken");
    expect(nextUp(forge.db, repo).rows.map((r) => r.issue.number)).not.toContain(latestRetro(forge.db, repo.id)!.proposals[0]!.number);
  });

  test("the terminal shows the retrospective and a reader's key takes nothing", async () => {
    const heard = latestRetro(forge.db, repo.id)!;
    expect(heard.proposals.length).toBeGreaterThan(1);
    const terminal = headlessTerminal(140, 40);
    const { app } = createForgeApp(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user: bob }, { terminal, exitHooks: false });
    app.start();
    const send = (key: string, ctrl = false) => app.dispatch({ type: "key", key, ctrl, alt: false, shift: false });
    await settleApp(app);
    send("k", true);
    await settleApp(app);
    for (const ch of "The week in a repository") send(ch);
    send("enter");
    await settleApp(app);
    for (const ch of "alice/plan") send(ch);
    send("enter");
    await settleApp(app);
    expect(app.screen.toText()).toContain("shipped");
    send("j");
    send("a");
    await settleApp(app);
    expect(takenOf(forge.db, repo.id, heard.weekEnd).has(1)).toBe(false);
    app.stop();
  });
});
