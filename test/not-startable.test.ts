/**
 * No ready issue goes unexplained (#8924): the picker's three passes (polish's
 * share, the owner's bets, a builder shunned from the issue) each name their
 * reason, and Next up says it on the web, in the terminal and over MCP. The
 * `wait_for` stop on the Later gate leaves the issue under a pillar.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue, setIssueLabels } from "../src/actions/issues.ts";
import { commitToBranch, createLabel, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { insertBet, markBacked } from "../src/core/bets.ts";
import { listCrewRoles } from "../src/core/agents.ts";
import { readyNow, repoGraph } from "../src/core/dependencies.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { nextUp } from "../src/core/next_up.ts";
import { pillarsOf, servedBy } from "../src/core/pillars.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { notStartable } from "../src/crew/not_startable.ts";
import { PASSED_WORDS, pickFilter, routable } from "../src/crew/pick_filter.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { expectWork, requestStatements } from "./helpers/work.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dataDir: string;
let app: App;
let alice: User;
let repo: Repo;
let servers: Servers;
let token: string;
let polish: Issue;
let shunned: Issue;
let plain: Issue;
let id = 1;
const STALLED = "a builder ran on it and left without a pull";

const fresh = () => getRepoById(app.db, repo.id)!;
const open = (title: string): Issue => {
  const made = openIssue(app, alice, fresh(), { title });
  if (!made.ok) throw new Error(String(made.error));
  return made.value;
};
const ready = () => readyNow(repoGraph(app.db, repo.id, { sealed: true }));
const reasons = () => notStartable(app, fresh(), ready(), { sealed: true });
const rowWhy = (n: number) => nextUp(app.db, fresh(), { sealed: true }, (r) => notStartable(app, fresh(), r, { sealed: true })).rows.find((r) => r.issue.number === n)?.why;

/** One MCP tool call as alice; the parsed answer. */
async function call(name: string, args: unknown): Promise<{ isError: boolean; value: any }> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  return { isError: body.result.isError === true, value: body.result.isError === true ? text : JSON.parse(text) };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-not-startable-"));
  app = createApp({ dataDir, port: 0 });
  const a = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
  const made = await createRepo(app, alice, { name: "notes", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const first = await commitToBranch(app, alice, repo, {
    message: "Start", files: [{ path: "package.json", content: `{"name":"notes"}\n` }],
  });
  if (!first.ok) throw new Error(JSON.stringify(first.error));
  const agent = await createAgent(app, alice, { username: "b1" });
  if (!agent.ok) throw new Error(String(agent.error));
  expect(addToCrew(app, alice, repo, "b1").ok).toBe(true);
  expect((await updateRepoSettings(app, alice, repo, {
    autonomy: "autonomous", autonomyDirection: "Keep the notes tidy.", autonomyCeilingUsd: 10, autonomySlots: 1, autonomyBy: alice.id,
  })).ok).toBe(true);
  insertApp(app.db, { repoId: repo.id, slug: "notes", access: "private" });
  open("P0 Notes: keep notes");
  createLabel(app, alice, fresh(), "polish", "888888");
  polish = open("Nudge the margins");
  expect(setIssueLabels(app, alice, fresh(), polish, ["polish"]).ok).toBe(true);
  shunned = open("Fix the sync");
  plain = open("Tag notes");
  servers = await serve(app);
  token = createToken(app.db, alice.id, "rw", "rw").token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the picker names why it passes a ready issue over", () => {
  test("polish over its share is passed over as polish_share, and only polish", () => {
    const old = open("Tidy the footer");
    expect(setIssueLabels(app, alice, fresh(), old, ["polish"]).ok).toBe(true);
    app.db.query("UPDATE issue SET state = 'closed', close_reason = 'done' WHERE id = ?1").run(old.id);
    const run = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: old.id, actorId: alice.id, reason: "assigned" });
    app.db.query("UPDATE run SET state = 'ok', cost_usd = 3, started_at = ?2 WHERE id = ?1").run(run.id, new Date().toISOString());
    const { allowed, passed } = pickFilter(app, fresh(), ready());
    expect(passed.get(polish.id)).toBe("polish_share");
    expect(passed.has(plain.id)).toBe(false);
    expect(allowed.map((r) => r.issue.id)).toContain(plain.id);
    expect(reasons().get(polish.id)).toBe(PASSED_WORDS.polish_share);
  });

  test("a builder shunned from an issue is held with its reason, and one with no builder to take it is no_builder", () => {
    const crew = listCrewRoles(app.db, repo.id);
    const b1 = crew.find((c) => c.agent.user.username === "b1")!;
    const run = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: shunned.id, actorId: b1.agent.user.id, reason: "assigned" });
    app.db.query("UPDATE run SET state = 'ok', summary = 'looked around', finished_at = ?2 WHERE id = ?1").run(run.id, new Date().toISOString());
    expect(reasons().get(shunned.id)).toBe(STALLED);
    const none = routable(app, fresh(), ready(), crew.filter((c) => c.role !== "builder"), new Date());
    expect(none.kept).toEqual([]);
    expect(none.passed.get(plain.id)).toBe("no_builder");
    expect(reasons().has(plain.id)).toBe(false);
  });

  test("once a bet is backed, an issue in no bet is passed over as no_bet", () => {
    expect(pickFilter(app, fresh(), ready()).passed.has(plain.id)).toBe(false);
    const bet = insertBet(app.db, { repoId: repo.id, name: "Tidy", journeys: "", appetite: 5, leadId: null, issueIds: [polish.id] }, new Date());
    markBacked(app.db, bet.id, 5, "owner", new Date());
    expect(pickFilter(app, fresh(), ready()).passed.get(plain.id)).toBe("no_bet");
    expect(reasons().get(plain.id)).toBe(PASSED_WORDS.no_bet);
  });
});

describe("Next up shows the reason on every surface", () => {
  test("core rows carry it", () => {
    expect(rowWhy(plain.number)).toBe(PASSED_WORDS.no_bet);
    expect(rowWhy(shunned.number)).toBe(STALLED);
  });

  test("the web page prints it", async () => {
    const res = await fetch(`${servers.url}/alice/notes/next`);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain(PASSED_WORDS.no_bet);
    expect(page).toContain(STALLED);
  });

  test("the page, reasons and all, costs a bounded number of statements", async () => {
    await fetch(`${servers.url}/alice/notes/next`);
    const n = await requestStatements(app.db, `${servers.url}/alice/notes/next`);
    expectWork(n, { max: 120 });
  });

  test("the MCP tool carries it as why", async () => {
    const answer = await call("next_up", { app: "alice/notes", all: true });
    const next = answer.value.next as { issue: number; why: string | null }[];
    expect(next.find((r) => r.issue === plain.number)?.why).toBe(PASSED_WORDS.no_bet);
    expect(next.find((r) => r.issue === shunned.number)?.why).toBe(STALLED);
  });

  test("the terminal prints it", async () => {
    const terminal = headlessTerminal(160, 40);
    const { app: tui } = createForgeApp(app, { sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(app.db, "alice") }, { terminal, exitHooks: false });
    tui.start();
    const type = async (text: string) => {
      for (const ch of text) tui.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
      await settleApp(tui);
    };
    const enter = async () => {
      tui.dispatch({ type: "key", key: "enter", ctrl: false, alt: false, shift: false });
      await settleApp(tui);
    };
    await settleApp(tui);
    tui.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
    await settleApp(tui);
    await type("Next up in a repository");
    await enter();
    await type("alice/notes");
    await enter();
    const text = tui.screen.toText();
    tui.stop();
    expect(text).toContain("Tag notes");
    expect(text).toContain("it is in no backed bet");
  });
});

describe("wait_for stop on the Later gate", () => {
  test("leaves the issue under a pillar and ready", async () => {
    const gate = open("Later gate: nothing behind this starts until the owner opens it");
    const held = open("Rename a note");
    expect(linkIssue(app, alice, fresh(), held, gate).ok).toBe(true);
    expect(servedBy(app.db, pillarsOf(app.db, fresh())).get(held.id)).toBe("Later");
    expect(ready().map((r) => r.issue.number)).not.toContain(held.number);
    const stopped = await call("wait_for", { app: "alice/notes", issue: held.number, blockedBy: gate.number, stop: true });
    expect(stopped.isError).toBe(false);
    expect(getIssueById(app.db, held.id)!.state).toBe("open");
    expect(servedBy(app.db, pillarsOf(app.db, fresh())).get(held.id)).toBe("P0 Notes");
    expect(ready().map((r) => r.issue.number)).toContain(held.number);
  });
});
