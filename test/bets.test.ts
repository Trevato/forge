/**
 * Bets (#8713): the owner backs a few named wholes with a share of the week;
 * builders pick from backed bets; a bet that spends its appetite stops; a
 * finished bet is a moment; the same state gives the same picks.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { backBet, endBet, giveVerdict, proposeBets, stopBet, tickBets, writeLeft } from "../src/actions/bets.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { insertNote } from "../src/core/app_notes.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { betScopes, getBet, insertBet, listBets, markBacked } from "../src/core/bets.ts";
import { createLabel, getIssueById, setIssueLabels, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { autoStarts, budgetSeconds, mayBack, mayPick, scopeState, spentSeconds, spentUp } from "../src/crew/bets.ts";
import { driveRepo } from "../src/crew/autonomy.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the rules", () => {
  test("builder time is the runs' span; an unfinished run counts up to now", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    expect(spentSeconds([{ startedAt: "2026-11-03T10:00:00Z", finishedAt: "2026-11-03T11:00:00Z" }, { startedAt: "2026-11-03T11:30:00Z", finishedAt: null }], now)).toBe(5400);
    expect(spentSeconds([{ startedAt: null, finishedAt: null }], now)).toBe(0);
  });

  test("a share of the week buys slots x week x share, and the bet stops at it", () => {
    expect(budgetSeconds(50, 2)).toBe(604800);
    expect(spentUp(604799, 604800)).toBe(false);
    expect(spentUp(604800, 604800)).toBe(true);
  });

  test("at most 5 run, the shares stay within the week, a share is 1 to 100", () => {
    expect(mayBack(Array(5).fill({ appetite: 10 }), 10)).toContain("5 bets");
    expect(mayBack([{ appetite: 60 }, { appetite: 30 }], 20)).toContain("whole week");
    expect(mayBack([], 0)).not.toBeNull();
    expect(mayBack([], 1.5)).not.toBeNull();
    expect(mayBack([{ appetite: 60 }], 40)).toBeNull();
  });

  test("the planner starts its top bets only when nothing is backed and the first proposal is a day old; the same state, the same ones", () => {
    const p = [{ id: "c", proposedAt: "2026-11-01T00:00:00Z" }, { id: "a", proposedAt: "2026-11-01T00:00:00Z" }, { id: "b", proposedAt: "2026-11-01T05:00:00Z" }];
    const day = new Date("2026-11-02T00:00:00Z");
    expect(autoStarts(p, 0, new Date("2026-11-01T23:59:00Z"))).toEqual([]);
    expect(autoStarts(p, 0, day)).toEqual(["a", "c"]);
    expect(autoStarts([...p].reverse(), 0, day)).toEqual(["a", "c"]);
    expect(autoStarts(p, 1, day)).toEqual([]);
  });

  test("a scope reads figuring out, executing, a raised hand when quiet for two days, or done", () => {
    const now = new Date("2026-11-05T00:00:00Z");
    expect(scopeState({ closed: false, ran: false, movedAt: "2026-11-04T00:00:00Z" }, now)).toBe("figuring out");
    expect(scopeState({ closed: false, ran: true, movedAt: "2026-11-04T00:00:00Z" }, now)).toBe("executing");
    expect(scopeState({ closed: false, ran: true, movedAt: "2026-11-02T00:00:00Z" }, now)).toBe("raised hand");
    expect(scopeState({ closed: true, ran: true, movedAt: "2026-11-02T00:00:00Z" }, now)).toBe("done");
  });

  test("an issue in no bet is not picked; the owner's ask, a small fix or a scope of a backed bet is", () => {
    expect(mayPick({ raised: false, small: false, bet: undefined })).toBe(false);
    expect(mayPick({ raised: true, small: false, bet: undefined })).toBe(true);
    expect(mayPick({ raised: false, small: true, bet: undefined })).toBe(true);
    expect(mayPick({ raised: false, small: false, bet: "b" })).toBe(true);
  });
});

let dataDir: string;
let app: App;
let alice: User;
let bob: User;
let repo: Repo;
let servers: Servers;
const fresh = () => getRepoById(app.db, repo.id)!;
const NOW = new Date("2026-11-03T12:00:00Z");

function open(title: string, into?: Repo): Issue {
  const made = openIssue(app, alice, into === undefined ? fresh() : getRepoById(app.db, into.id)!, { title });
  if (!made.ok) throw new Error(String(made.error));
  return made.value;
}

/** A repository of its own, so a test's issues and bets touch no other test's; named to sort after "notes", whose bets the terminal lists first. */
async function blank(name: string): Promise<Repo> {
  const made = await createRepo(app, alice, { name, visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  return made.value;
}

function label(into: Repo, name: string, issues: readonly Issue[]): void {
  const made = createLabel(app.db, into.id, name, "aabbcc");
  if (!made.ok) throw new Error(String(made.error));
  for (const i of issues) setIssueLabels(app.db, i.id, [made.value.id]);
}

/** The same state, built anew in a fresh repository: a pillar pair with a note naming it, a word pair, a label pair. */
async function sameState(name: string): Promise<{ name: string; journeys: string; scopes: string[] }[]> {
  const into = await blank(name);
  const umbrella = open("P7 Speed: be quick", into);
  const a = open("Cache the rendered page", into);
  const b = open("Trim the startup path", into);
  for (const i of [a, b]) expect(addDependency(app.db, umbrella, i, alice.id).ok).toBe(true);
  const asked = open(`Please make #${a.number} faster for me`, into);
  insertNote(app.db, { appId: "app-x", repoId: into.id, issueNumber: asked.number, visitor: `u:${alice.id}`, name: "alice" });
  open("Export zebra stripes", into);
  open("Import zebra stripes", into);
  label(into, "search", [open("Find by word", into), open("Find by tag", into)]);
  return proposeBets(app, getRepoById(app.db, into.id)!, NOW).map((bet) => ({
    name: bet.name,
    journeys: bet.journeys,
    scopes: betScopes(app.db, bet.id).map((sc) => sc.title).sort(),
  }));
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-bets-"));
  app = createApp({ dataDir, port: 0 });
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!b.ok) throw new Error(b.error);
  bob = b.value;
  const made = await createRepo(app, alice, { name: "notes", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const first = await commitToBranch(app, alice, repo, { message: "Start", files: [{ path: "a.txt", content: "a\n" }] });
  if (!first.ok) throw new Error(JSON.stringify(first.error));
  for (const name of ["b1", "b2", "b3"]) {
    const agent = await createAgent(app, alice, { username: name });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, repo, name).ok).toBe(true);
  }
  expect((await updateRepoSettings(app, alice, repo, { autonomy: "autonomous", autonomyDirection: "Keep notes tidy.", autonomyCeilingUsd: 10, autonomySlots: 3, autonomyBy: alice.id })).ok).toBe(true);
  servers = await serve(app);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("proposing from unlabelled work and notes (#8850)", () => {
  test("an unlabelled pair under one pillar is one proposal; a note that names it joins and is quoted; same state, same proposals", () => {
    const umbrella = open("P7 Speed: be quick");
    const a = open("Cache the rendered page");
    const b = open("Trim the startup path");
    for (const i of [a, b]) expect(addDependency(app.db, umbrella, i, alice.id).ok).toBe(true);
    const asked = open(`Please make #${a.number} faster for me`);
    insertNote(app.db, { appId: "app-x", repoId: repo.id, issueNumber: asked.number, visitor: `u:${alice.id}`, name: "alice" });
    const made = proposeBets(app, fresh(), NOW);
    const speed = made.find((m) => m.name === "P7 Speed");
    expect(speed).toBeDefined();
    expect(speed!.journeys).toContain("Someone can Cache the rendered page");
    expect(speed!.journeys).toContain(`The owner's note: "Please make #${a.number} faster for me"`);
    expect(betScopes(app.db, speed!.id).map((s) => s.number).sort()).toEqual([a.number, b.number, asked.number].sort());
    expect(made.length).toBeLessThanOrEqual(5);
    expect(proposeBets(app, fresh(), NOW)).toEqual([]);
  });

  test("the same state gives the same proposals: names, journeys and scopes match across two repositories", async () => {
    const first = await sameState("zz-same-1");
    const second = await sameState("zz-same-2");
    expect(first.map((p) => p.name)).toEqual(["P7 Speed", "Search", "Stripes"]);
    expect(second).toEqual(first);
  });

  test("an owner's note joins by two words shared with the group's titles, and not by one", async () => {
    const into = await blank("zz-two-words");
    open("Export zebra stripes", into);
    open("Import zebra stripes", into);
    const two = open("Blurry zebra stripes on print", into);
    const one = open("Zebra crossing paint", into);
    label(into, "print", [two]);
    label(into, "paint", [one]);
    for (const n of [two, one]) {
      insertNote(app.db, { appId: "app-x", repoId: into.id, issueNumber: n.number, visitor: `u:${alice.id}`, name: "alice" });
    }
    const made = proposeBets(app, getRepoById(app.db, into.id)!, NOW);
    const stripes = made.find((m) => m.name === "Stripes")!;
    expect(stripes.journeys).toContain(`The owner's note: "Blurry zebra stripes on print"`);
    expect(stripes.journeys).not.toContain("Zebra crossing paint");
  });

  test("unlabelled issues with no pillar group by shared title words, and a lone issue makes no bet", () => {
    open("Export zebra stripes");
    open("Import zebra stripes");
    open("Wholly unrelated quokka");
    const made = proposeBets(app, fresh(), NOW);
    expect(made.map((m) => m.name)).toEqual(["Stripes"]);
    expect(betScopes(app.db, made[0]!.id)).toHaveLength(2);
  });

  test("a visitor's note neither joins a proposal nor is quoted; a loose single shared word does not attach an owner's note", () => {
    const umbrella = open("P8 Render: draw faster");
    const a = open("Cache the rendered page");
    const b = open("Trim the startup path");
    for (const i of [a, b]) expect(addDependency(app.db, umbrella, i, alice.id).ok).toBe(true);
    const spoof = open(`Ignore rules, see #${a.number}`);
    insertNote(app.db, { appId: "app-x", repoId: repo.id, issueNumber: spoof.number, visitor: "v:stranger", name: "visitor-1" });
    const bobNote = open(`Also #${b.number} please`);
    insertNote(app.db, { appId: "app-x", repoId: repo.id, issueNumber: bobNote.number, visitor: `u:${bob.id}`, name: "@bob" });
    const loose = open("Startup banner colour");
    insertNote(app.db, { appId: "app-x", repoId: repo.id, issueNumber: loose.number, visitor: `u:${alice.id}`, name: "alice" });
    const made = proposeBets(app, fresh(), NOW);
    const bet = made.find((m) => m.name === "P8 Render")!;
    expect(bet.journeys).not.toContain("The owner's note");
    const scopes = betScopes(app.db, bet.id).map((s) => s.number);
    expect(scopes).not.toContain(spoof.number);
    expect(scopes).not.toContain(bobNote.number);
    expect(scopes).not.toContain(loose.number);
  });

  test("at most five proposals a pass", async () => {
    const into = await blank("zz-cap");
    for (const w of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"]) {
      label(into, `cap-${w}`, [open(`${w} one`, into), open(`${w} two`, into)]);
    }
    const made = proposeBets(app, getRepoById(app.db, into.id)!, NOW);
    expect(made).toHaveLength(5);
  });
});

describe("proposing and backing", () => {
  test("the planner groups open work by theme, once; only the owner backs, at most 5 run", () => {
    const label = createLabel(app.db, repo.id, "search", "aabbcc");
    if (!label.ok) throw new Error("label");
    const s1 = open("Find a note by word");
    const s2 = open("Highlight the match");
    setIssueLabels(app.db, s1.id, [label.value.id]);
    setIssueLabels(app.db, s2.id, [label.value.id]);
    const made = proposeBets(app, fresh(), NOW);
    expect(made.map((m) => m.name)).toEqual(["Search"]);
    expect(proposeBets(app, fresh(), NOW)).toEqual([]);
    const bet = made[0]!;
    expect(bet.state).toBe("proposed");
    expect(backBet(app, bob, fresh(), bet.id, 30, NOW).ok).toBe(false);
    expect(backBet(app, alice, fresh(), bet.id, 0, NOW).ok).toBe(false);
    const backed = backBet(app, alice, fresh(), bet.id, 30, NOW);
    expect(backed.ok && backed.value.state).toBe("backed");
    expect(backed.ok && backed.value.backedBy).toBe("owner");
    for (let n = 0; n < 4; n++) {
      const extra = insertBet(app.db, { repoId: repo.id, name: `Extra ${n}`, journeys: "", appetite: 5, leadId: null, issueIds: [] }, NOW);
      expect(backBet(app, alice, fresh(), extra.id, 5, NOW).ok).toBe(true);
    }
    const sixth = insertBet(app.db, { repoId: repo.id, name: "Sixth", journeys: "", appetite: 5, leadId: null, issueIds: [] }, NOW);
    const refused = backBet(app, alice, fresh(), sixth.id, 5, NOW);
    expect(!refused.ok && refused.error.message).toContain("5 bets");
    for (const b of listBets(app.db, repo.id)) if (b.name !== "Search" && b.state === "backed") expect(stopBet(app, alice, fresh(), b.id, NOW).ok).toBe(true);
  });
});

describe("builders pick from backed bets", () => {
  test("an issue in no bet does not start; a scope of a backed bet does, the same every time", async () => {
    const outside = open("Rename the app");
    const bet = listBets(app.db, repo.id).find((b) => b.name === "Search")!;
    const scopes = app.db.query<{ issue_id: string }, [string]>("SELECT issue_id FROM bet_issue WHERE bet_id = ?1").all(bet.id).map((r) => r.issue_id);
    expect(scopes.length).toBe(2);
    const picked: string[] = [];
    for (let n = 0; n < 3; n++) {
      if ((await driveRepo(app, fresh())) === "picked") {
        const hit = [...scopes, outside.id].filter((id) => getIssueById(app.db, id)!.assigneeId !== null);
        picked.push(...hit);
        break;
      }
    }
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.every((id) => scopes.includes(id))).toBe(true);
    expect(getIssueById(app.db, outside.id)!.assigneeId).toBeNull();
  });
});

describe("a bet that hits its appetite stops", () => {
  test("no extension: it stops with a left line the lead can rewrite, and the owner re-backs it", () => {
    const issue = open("Tag a note");
    const bet = insertBet(app.db, { repoId: repo.id, name: "Tags", journeys: "Someone can tag a note", appetite: 10, leadId: alice.id, issueIds: [issue.id] }, NOW);
    markBacked(app.db, bet.id, 10, "owner", NOW);
    const runAt = new Date(NOW.getTime() + 1000);
    app.db.query("INSERT INTO run (id, repo_id, kind, issue_id, state, started_at, finished_at) VALUES ('r-bet', ?1, 'agent', ?2, 'ok', ?3, ?4)")
      .run(repo.id, issue.id, NOW.toISOString(), new Date(NOW.getTime() + budgetSeconds(10, 3) * 1000).toISOString());
    expect(getBet(app.db, bet.id)!.state).toBe("backed");
    const out = tickBets(app, fresh(), runAt);
    expect(out.stopped).toBe(1);
    const stopped = getBet(app.db, bet.id)!;
    expect(stopped.state).toBe("stopped");
    expect(stopped.leftLine).toContain("Tag a note");
    expect(tickBets(app, fresh(), runAt).stopped).toBe(0);
    expect(writeLeft(app, bob, fresh(), bet.id, "x").ok).toBe(false);
    expect(writeLeft(app, alice, fresh(), bet.id, "Only the tag colours remain.").ok).toBe(true);
    expect(getBet(app.db, bet.id)!.leftLine).toBe("Only the tag colours remain.");
    expect(endBet(app, alice, fresh(), bet.id, "cut", runAt).ok).toBe(true);
  });
});

describe("finishing is a moment", () => {
  test("all scopes closed finishes the bet; the owner says feels done or not yet and why", () => {
    const issue = open("Pin a note");
    const bet = insertBet(app.db, { repoId: repo.id, name: "Pins", journeys: "Someone can pin a note", appetite: 10, leadId: null, issueIds: [issue.id] }, NOW);
    markBacked(app.db, bet.id, 10, "owner", NOW);
    app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(issue.id);
    expect(tickBets(app, fresh(), NOW).finished).toBe(1);
    const done = getBet(app.db, bet.id)!;
    expect(done.state).toBe("done");
    expect(done.tryUrl).toBe("/alice/notes");
    expect(giveVerdict(app, bob, fresh(), bet.id, "done", "", NOW).ok).toBe(false);
    expect(giveVerdict(app, alice, fresh(), bet.id, "not_yet", "", NOW).ok).toBe(false);
    expect(giveVerdict(app, alice, fresh(), bet.id, "not_yet", "Pins do not survive a reload.", NOW).ok).toBe(true);
    const back = getBet(app.db, bet.id)!;
    expect(back.state).toBe("stopped");
    expect(back.leftLine).toBe("Pins do not survive a reload.");
  });
});

describe("when nothing is backed", () => {
  test("a day later the planner's top bets start, marked as not the owner's; one tap stops one", async () => {
    app.db.query("DELETE FROM bet WHERE repo_id = ?1").run(repo.id);
    const a = insertBet(app.db, { repoId: repo.id, name: "A", journeys: "", appetite: 20, leadId: null, issueIds: [] }, NOW);
    insertBet(app.db, { repoId: repo.id, name: "B", journeys: "", appetite: 20, leadId: null, issueIds: [] }, new Date(NOW.getTime() + 1000));
    expect(tickBets(app, fresh(), new Date(NOW.getTime() + 3600_000)).started).toBe(0);
    expect(tickBets(app, fresh(), new Date(NOW.getTime() + 25 * 3600_000)).started).toBe(2);
    const started = getBet(app.db, a.id)!;
    expect(started.state).toBe("backed");
    expect(started.backedBy).toBe("planner");
    expect(stopBet(app, alice, fresh(), a.id, NOW).ok).toBe(true);
    // The owner's stop is not undone by the planner.
    expect(tickBets(app, fresh(), new Date(NOW.getTime() + 26 * 3600_000)).started).toBe(0);
  });
});

describe("the pages", () => {
  test("the list and a bet render server-side, escaped, and a cross-origin POST is refused", async () => {
    const evil = insertBet(app.db, { repoId: repo.id, name: "<script>alert(1)</script>", journeys: "<b>x</b>", appetite: 5, leadId: null, issueIds: [] }, NOW);
    const list = await (await fetch(`${servers.url}/alice/notes/bets`)).text();
    expect(list).toContain("Bets");
    expect(list).not.toContain("<script>alert(1)</script>");
    const one = await (await fetch(`${servers.url}/alice/notes/bets/${evil.id}`, { headers: { cookie: await signIn("alice") } })).text();
    expect(one).toContain("&lt;b&gt;x&lt;/b&gt;");
    const post = await fetch(`${servers.url}/alice/notes/bets/${evil.id}/stop`, { method: "POST", redirect: "manual", headers: { origin: "https://evil.example" } });
    expect(post.status).toBe(403);
  });
});

// ---- review round: ending, visibility, the pick path, the changelog, the MCP, the terminal ----

import { betNamesOfPulls } from "../src/core/bets.ts";
import { getUserByName } from "../src/core/users.ts";
import { tool as betTool } from "../src/http/mcp/tools/bet.ts";
import { tool as betsTool } from "../src/http/mcp/tools/bets.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";

const stateOf = (id: string) => getBet(app.db, id)!.state;
const fresh2 = (name: string, scopes: string[] = []) =>
  insertBet(app.db, { repoId: repo.id, name, journeys: "Someone can see the plan", appetite: 10, leadId: null, issueIds: scopes }, NOW);

async function signIn(username: string): Promise<string> {
  const r = await fetch(`${servers.url}/signin`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ username, password: "a-good-passphrase" }),
  });
  return (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}
const act = (cookie: string, path: string, body: Record<string, string> = {}) =>
  fetch(`${servers.url}${path}`, {
    method: "POST", redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams(body),
  });

describe("ending", () => {
  test("only a stopped bet is ended as done; a proposed or running one is refused and stays", () => {
    const b = fresh2("Ending");
    expect(endBet(app, alice, fresh(), b.id, "done", NOW).ok).toBe(false);
    markBacked(app.db, b.id, 10, "owner", NOW);
    expect(endBet(app, alice, fresh(), b.id, "done", NOW).ok).toBe(false);
    expect(stateOf(b.id)).toBe("backed");
    expect(stopBet(app, alice, fresh(), b.id, NOW).ok).toBe(true);
    expect(endBet(app, alice, fresh(), b.id, "done", NOW).ok).toBe(true);
    expect(getBet(app.db, b.id)!.tryUrl).toBe("/alice/notes");
  });
});

describe("who sees and who acts, on the page", () => {
  test("a reader sees names and states, not the plan; a non-owner's POST changes nothing; another repo's bet is 404", async () => {
    const b = fresh2("Visible");
    setLeft(b.id);
    const bob = await signIn("bob");
    const list = await (await fetch(`${servers.url}/alice/notes/bets`, { headers: { cookie: bob } })).text();
    expect(list).toContain("Visible");
    expect(list).not.toContain("10% of the week");
    const one = await (await fetch(`${servers.url}/alice/notes/bets/${b.id}`, { headers: { cookie: bob } })).text();
    expect(one).not.toContain("Someone can see the plan");
    expect(one).not.toContain("secret reason");
    const post = await act(bob, `/alice/notes/bets/${b.id}/back`, { share: "10" });
    expect(post.status).toBe(303);
    expect(stateOf(b.id)).toBe("proposed");
    const guest = await fetch(`${servers.url}/alice/notes/bets/${b.id}/back`, { method: "POST", redirect: "manual", headers: { origin: servers.url, "content-type": "application/x-www-form-urlencoded" }, body: "share=10" });
    expect([303, 401, 403]).toContain(guest.status);
    expect(stateOf(b.id)).toBe("proposed");

    const other = await createRepo(app, alice, { name: "other", visibility: "public" });
    if (!other.ok) throw new Error("repo");
    const foreign = insertBet(app.db, { repoId: other.value.id, name: "Foreign", journeys: "", appetite: 5, leadId: null, issueIds: [] }, NOW);
    expect((await fetch(`${servers.url}/alice/notes/bets/${foreign.id}`)).status).toBe(404);
    const cross = await act(await signIn("alice"), `/alice/notes/bets/${foreign.id}/back`, { share: "5" });
    expect(stateOf(foreign.id)).toBe("proposed");
    expect(cross.status).toBe(303);
  });

  test("the owner's page POSTs back, a refusal lands on the bet, and not-yet returns it to stopped", async () => {
    const alicec = await signIn("alice");
    const b = fresh2("Flow");
    expect((await act(alicec, `/alice/notes/bets/${b.id}/back`, { share: "15" })).status).toBe(303);
    expect(stateOf(b.id)).toBe("backed");
    const refused = await act(alicec, `/alice/notes/bets/${b.id}/end`);
    expect(refused.headers.get("location")).toContain(`/bets/${b.id}`);
    expect(stateOf(b.id)).toBe("backed");
    app.db.query("UPDATE bet SET state = 'done', ended_at = ?2 WHERE id = ?1").run(b.id, NOW.toISOString());
    await act(alicec, `/alice/notes/bets/${b.id}/verdict`, { verdict: "not_yet", why: "Too slow." });
    expect(stateOf(b.id)).toBe("stopped");
    expect(getBet(app.db, b.id)!.leftLine).toBe("Too slow.");
  });
});

function setLeft(id: string): void {
  app.db.query("UPDATE bet SET left_line = 'secret reason' WHERE id = ?1").run(id);
}

describe("the MCP", () => {
  const ctxFor = (user: User) => ({ app, auth: { user, scope: "rw" } }) as never;
  test("the owner reads the plan and acts; a reader reads names; an agent and a reader are refused every act", async () => {
    const b = fresh2("Mcp", []);
    const agent = getUserByName(app.db, "b1")!;
    const read = await betsTool.run(ctxFor(alice), alice, { app: "alice/notes" });
    expect(JSON.stringify(read)).toContain("Someone can see the plan");
    const seen = await betsTool.run(ctxFor(bob), bob, { app: "alice/notes" });
    expect(JSON.stringify(seen)).toContain("Mcp");
    expect(JSON.stringify(seen)).not.toContain("Someone can see the plan");
    for (const who of [agent, bob]) {
      for (const args of [{ verb: "back", bet: b.id, share: 10 }, { verb: "stop", bet: b.id }, { verb: "cut", bet: b.id }, { verb: "propose" }]) {
        const r = await betTool.run(ctxFor(who), who, { app: "alice/notes", ...args });
        expect(r.ok).toBe(false);
      }
    }
    expect(stateOf(b.id)).toBe("proposed");
    const ok = await betTool.run(ctxFor(alice), alice, { app: "alice/notes", verb: "back", bet: b.id, share: 10 });
    expect(ok.ok).toBe(true);
    expect(stateOf(b.id)).toBe("backed");
    // A read-only token cannot act.
    const ro = await betTool.run({ app, auth: { user: alice, scope: "ro" } } as never, alice, { app: "alice/notes", verb: "stop", bet: b.id });
    expect(ro.ok).toBe(false);
    expect(stateOf(b.id)).toBe("backed");
  });
});

describe("the changelog names the bet", () => {
  test("a pull built from a bet's scope, by its run's branch, is named for the bet", () => {
    const scope = open("Build the thing");
    const pull = open("The pull");
    app.db.query("UPDATE issue SET kind = 'pull' WHERE id = ?1").run(pull.id);
    app.db.query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?1, 'main', 'crew/x', 'a', 'b')").run(pull.id);
    app.db.query("INSERT INTO run (id, repo_id, kind, issue_id, state, branch) VALUES ('r-log', ?1, 'agent', ?2, 'ok', 'crew/x')").run(repo.id, scope.id);
    const b = fresh2("Logged", [scope.id]);
    expect(betNamesOfPulls(app.db, repo.id, [pull.number]).get(pull.number)).toBe("Logged");
    expect(betNamesOfPulls(app.db, repo.id, [pull.number + 100]).size).toBe(0);
    expect(b.name).toBe("Logged");
  });
});

describe("the same state gives the same pick", () => {
  test("the pick path run twice from the same state picks the same issue", async () => {
    for (const b of listBets(app.db, repo.id)) if (b.state === "backed") stopBet(app, alice, fresh(), b.id, NOW);
    app.db.query("UPDATE issue SET assignee_id = NULL").run();
    const one = open("Twin one");
    const two = open("Twin two");
    const bet = fresh2("Twins", [one.id, two.id]);
    markBacked(app.db, bet.id, 10, "owner", NOW);
    const pickOnce = async (): Promise<string | undefined> => {
      if ((await driveRepo(app, fresh())) !== "picked") return undefined;
      const hit = [one, two].find((i) => getIssueById(app.db, i.id)!.assigneeId !== null);
      app.db.query("UPDATE issue SET assignee_id = NULL WHERE id IN (?1, ?2)").run(one.id, two.id);
      app.db.query("DELETE FROM run WHERE issue_id IN (?1, ?2)").run(one.id, two.id);
      return hit?.id;
    };
    const first = await pickOnce();
    const second = await pickOnce();
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });
});

describe("the terminal", () => {
  function boot(username: string) {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(app.db, username)!;
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app: tui } = createForgeApp(app, identity, { terminal, exitHooks: false });
    tui.start();
    const press = async (...keys: string[]) => {
      for (const k of keys) {
        tui.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
        await settleApp(tui);
      }
    };
    const type = async (t: string) => {
      for (const ch of t) tui.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
      await settleApp(tui);
    };
    const openBets = async () => {
      tui.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
      await settleApp(tui);
      await type("Bets");
      await press("enter");
    };
    return { text: () => tui.screen.toText(), press, type, openBets, stop: () => tui.stop() };
  }

  test("the owner stops, ends, says not yet and proposes from the screen, each an event the web follows; a reader sees nothing and changes nothing", async () => {
    app.db.query("DELETE FROM bet WHERE repo_id = ?1").run(repo.id);
    const b = fresh2("Terminal");
    markBacked(app.db, b.id, 10, "owner", NOW);
    const before = app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM event WHERE kind LIKE 'bet.%'").get()!.n;

    const reader = boot("bob");
    await reader.openBets();
    expect(reader.text()).toContain("Bets are for the person who administers a repository.");
    await reader.press("s");
    expect(stateOf(b.id)).toBe("backed");
    reader.stop();

    const h = boot("alice");
    await h.openBets();
    expect(h.text()).toContain("Terminal");
    await h.press("s");
    expect(stateOf(b.id)).toBe("stopped");
    await h.press("e");
    expect(stateOf(b.id)).toBe("done");
    await h.press("n");
    await h.type("Not good enough");
    await h.press("enter");
    expect(stateOf(b.id)).toBe("stopped");
    expect(getBet(app.db, b.id)!.leftLine).toBe("Not good enough");
    const after = app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM event WHERE kind LIKE 'bet.%'").get()!.n;
    expect(after).toBeGreaterThanOrEqual(before + 3);
    h.stop();
  });
});

describe("a proposed bet is one card backed with one tap", () => {
  test("the card shows the button at the proposed share; one POST backs it; a sixth is disabled with the reason and refused", async () => {
    app.db.query("DELETE FROM bet WHERE repo_id = ?1").run(repo.id);
    const cookie = await signIn("alice");
    const one = fresh2("Tap");
    const html1 = await (await fetch(`${servers.url}/alice/notes/bets`, { headers: { cookie } })).text();
    expect(html1).toContain("Back it at 10%");
    expect(html1).toContain("Change the share");
    expect(html1).not.toMatch(/<button[^>]*disabled[^>]*>\s*Back it at 10%/);
    const res = await act(cookie, `/alice/notes/bets/${one.id}/back`, { share: "10" });
    expect(res.status).toBe(303);
    expect(getBet(app.db, one.id)!.appetite).toBe(10);
    expect(stateOf(one.id)).toBe("backed");
    for (let i = 0; i < 4; i++) markBacked(app.db, fresh2(`Run${i}`).id, 10, "owner", NOW);
    const sixth = fresh2("Sixth");
    const page = await (await fetch(`${servers.url}/alice/notes/bets`, { headers: { cookie } })).text();
    expect(page).toContain("5 bets already run");
    expect(page).toMatch(/<button[^>]*disabled[^>]*>\s*Back it at 10%/);
    const refused = await act(cookie, `/alice/notes/bets/${sixth.id}/back`, { share: "10" });
    expect(stateOf(sixth.id)).toBe("proposed");
    expect(refused.status).toBe(303);
    const flash = refused.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const shown = await (await fetch(new URL(refused.headers.get("location")!, servers.url), { headers: { cookie: `${cookie}; ${flash}` } })).text();
    expect(shown).toContain("5 bets already run");
  });
});

describe("a proposed bet card stays one screen tall (#8970)", () => {
  const card = async (journeys: string) => {
    app.db.query("DELETE FROM bet WHERE repo_id = ?1").run(repo.id);
    const cookie = await signIn("alice");
    const b = fresh2("Many");
    app.db.query("UPDATE bet SET journeys = ?1 WHERE id = ?2").run(journeys, b.id);
    return await (await fetch(`${servers.url}/alice/notes/bets`, { headers: { cookie } })).text();
  };
  test("three journeys at rest; the rest sit inside a details that names them", async () => {
    const out = await card("j1\nj2\nj3\nj4\nj5");
    expect(out).toContain("data-bet-card");
    const [rest, folded] = out.split(/<details>\s*<summary>2 more journeys<\/summary>/);
    expect(folded).toBeDefined();
    for (const j of ["j1", "j2", "j3"]) expect(rest).toContain(`<li>${j}</li>`);
    for (const j of ["j4", "j5"]) {
      expect(rest).not.toContain(`<li>${j}</li>`);
      expect(folded!.split("</details>")[0]).toContain(`<li>${j}</li>`);
    }
  });
  test("three or fewer journeys have no disclosure", async () => {
    const out = await card("j1\nj2\nj3");
    expect(out).toContain("<li>j3</li>");
    expect(out).not.toMatch(/more journeys?</);
  });
  test("one folded journey reads in the singular", async () => {
    expect(await card("j1\nj2\nj3\nj4")).toContain("1 more journey</summary>");
  });
});
