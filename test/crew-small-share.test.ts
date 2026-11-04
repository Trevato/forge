/**
 * Builder slots serve the roadmap first (#7571): small issues — tests-only
 * or small additions — hold at most `slots.smallShare` of the slots, and an
 * issue under an open epic starts before a small one.
 */
import { quietWeek } from "./helpers/week-quiet.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { smallShare } from "../src/core/capacity.ts";
import { readyNow, repoGraph } from "../src/core/dependencies.ts";
import { nextUp } from "../src/core/next_up.ts";
import { putFirst } from "../src/core/first.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { driveRepo, inSlotOrder, smallShareWords } from "../src/crew/autonomy.ts";
import { isSmall, shareWords, slotOrder, smallCap, smallIssuesWords } from "../src/crew/small_share.ts";
import { readHeld } from "../src/flow/held.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { heldLines } from "../src/tui/screens/flow.ts";

describe("the rules", () => {
  test("a test that pins something, or a tests/small label, is small; a feature is not", () => {
    expect(isSmall("A test pins the merge queue's batch size", [])).toBe(true);
    expect(isSmall("Tests: cover the people screen", [])).toBe(true);
    expect(isSmall("Add a terminal shortcut", ["small"])).toBe(true);
    expect(isSmall("Search notes by word", ["feature"])).toBe(false);
  });

  test("5 slots at 30% hold 2 small; 1 slot still holds 1; 0% holds none", () => {
    expect(smallCap(5, 30)).toBe(2);
    expect(smallCap(1, 30)).toBe(1);
    expect(smallCap(5, 0)).toBe(0);
    expect(smallCap(5, 100)).toBe(5);
  });

  test("the order given is kept, and small work is left out at the cap unless ranked", () => {
    const c = (t: string) => ({ ranked: t.endsWith("^"), small: t.startsWith("s") });
    expect(slotOrder(["s1", "o1", "r1", "s2"], c, 0, 2)).toEqual(["s1", "o1", "r1", "s2"]);
    expect(slotOrder(["s1", "o1", "s2^", "r1"], c, 2, 2)).toEqual(["o1", "s2^", "r1"]);
  });

  test("each label the docs name is small, and the words read as the doors print them", () => {
    for (const label of ["test", "tests", "tests-only", "small"]) expect(isSmall("Anything", [label])).toBe(true);
    expect(shareWords(1, 2)).toBe("1/2");
    expect(smallIssuesWords({ running: 1, cap: 2 })).toBe("small issues: 1 of 2 slots");
  });
});

let dataDir: string;
let app: App;
let alice: User;
let repo: Repo;
let servers: Servers;
let cookie: string;

const get = (path: string) =>
  fetch(`${servers.url}${path}`, { headers: { cookie: `${cookie}; forge_mode=studio` }, redirect: "manual" });

/** Sets `slots.smallShare` as an admin does, on /settings/capacity. */
const setShare = (value: string) =>
  fetch(`${servers.url}/settings/capacity`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ key: "slots.smallShare", value }),
  });

const fresh = () => getRepoById(app.db, repo.id)!;

/** Every issue opened here, for a drive that may pick any of them. */
const opened: Issue[] = [];

function open(title: string): Issue {
  const made = openIssue(app, alice, fresh(), { title });
  if (!made.ok) throw new Error(String(made.error));
  opened.push(made.value);
  return made.value;
}

/** Drives once; a tick starts one issue per free slot, and each pick gets the run its assignment would start. */
async function drive(issues: readonly Issue[]): Promise<Issue[]> {
  const before = new Set(issues.filter((i) => getIssueById(app.db, i.id)!.assigneeId !== null).map((i) => i.id));
  if ((await driveRepo(app, fresh())) !== "picked") return [];
  const picked = issues.map((i) => getIssueById(app.db, i.id)!).filter((i) => i.assigneeId !== null && !before.has(i.id));
  for (const i of picked)
    createRun(app.db, { repoId: repo.id, kind: "agent", issueId: i.id, actorId: i.assigneeId ?? undefined, reason: "assigned" });
  return picked;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-small-share-"));
  app = createApp({ dataDir, port: 0 });
  quietWeek(app.db);
  const a = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
  const made = await createRepo(app, alice, { name: "notes", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const first = await commitToBranch(app, alice, repo, {
    message: "Start",
    files: [
      { path: "package.json", content: `{"name":"notes","scripts":{"start":"bun run server.ts"}}\n` },
      { path: "server.ts", content: "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n" },
    ],
  });
  if (!first.ok) throw new Error(JSON.stringify(first.error));
  // An app, so /board's Today has a row for it.
  const enabled = await enableApp(app, alice, repo, { slug: "notes" });
  if (!enabled.ok) throw new Error(String(enabled.error));
  for (const name of ["b1", "b2", "b3", "b4", "b5"]) {
    const agent = await createAgent(app, alice, { username: name });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, repo, name).ok).toBe(true);
  }
  const on = await updateRepoSettings(app, alice, repo, {
    autonomy: "autonomous",
    autonomyDirection: "Keep the notes tidy.",
    autonomyCeilingUsd: 10,
    autonomySlots: 5,
    autonomyBy: alice.id,
  });
  expect(on.ok).toBe(true);
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("with 5 slots and only small issues ready, at most 2 start; then an epic's issue starts before a small one", async () => {
  expect(smallShare(app.db)).toBe(30);
  const small = ["A test pins the title", "A test pins the body", "A test pins the date", "A test pins the tags"].map(open);
  const started: Issue[] = [];
  for (let n = 0; n < 5; n++) {
    started.push(...(await drive(small)));
  }
  expect(started.length).toBe(2);
  expect(smallShareWords(app, fresh())).toBe("2/2");

  // Room is made for one more small one, and an epic's issue arrives beside it.
  const epic = open("Notes search");
  const child = open("Search notes by word");
  expect(linkIssue(app, alice, fresh(), epic, child).ok).toBe(true);
  app.db.query("UPDATE run SET state = 'ok' WHERE issue_id = ?1").run(started[0]!.id);
  const next = await drive([...small, child]);
  expect(next.map((i) => i.id)).toContain(child.id);
});

test("one small issue of two slots shows on /board's Today, the studio's crew panel and the terminal's Flow", async () => {
  expect(smallShareWords(app, fresh())).toBe("2/2");
  const board = await (await get("/board")).text();
  const today = board.slice(board.indexOf('id="today"'));
  expect(today).toContain("small issues: 2 of 2 slots");
  const studio = await (await get("/alice/notes/settings")).text();
  expect(studio).toMatch(/<dt>Small issues<\/dt>\s*<dd>2\/2 slots<\/dd>/);
  const flow = heldLines(readHeld(app, true), 200).join("\n");
  expect(flow).toMatch(/^alice\/notes startable=\d+.* small 2\/2$/m);
});

test("what the owner raised again is first in the page's order and in the picker's, ahead of an older epic issue", async () => {
  const epic = open("Notes export");
  const child = open("Export notes as text");
  const plain = open("Rename a note");
  expect(linkIssue(app, alice, fresh(), epic, child).ok).toBe(true);
  app.db.query("INSERT INTO issue_raise (issue_id, raised_at) VALUES (?1, ?2)").run(plain.id, new Date().toISOString());
  const mine = new Set([plain.id, child.id]);
  const ready = readyNow(repoGraph(app.db, repo.id, { sealed: true }));
  const picker = inSlotOrder(app, fresh(), ready, [], 5).map((r) => r.issue.id).filter((id) => mine.has(id));
  const page = nextUp(app.db, fresh()).rows.map((r) => r.issue.id).filter((id) => mine.has(id));
  expect(picker).toEqual([plain.id, child.id]);
  expect(page).toEqual(picker);
  // Both start in the one tick: slots are free for the owner's issue and the epic's.
  expect((await drive([plain, child])).map((i) => i.id).sort()).toEqual([plain.id, child.id].sort());
});

test("an epic's issue leads older plain work only as the page's ready order has it, and what a person put first leads both", async () => {
  const older = open("Sort notes by date");
  const epic = open("Notes import");
  const child = open("Import notes from text");
  expect(linkIssue(app, alice, fresh(), epic, child).ok).toBe(true);
  const order = () => {
    const mine = new Set([older.id, child.id]);
    const ready = readyNow(repoGraph(app.db, repo.id, { sealed: true }));
    const picker = inSlotOrder(app, fresh(), ready, [], 5).map((r) => r.issue.id).filter((id) => mine.has(id));
    const page = nextUp(app.db, fresh()).rows.map((r) => r.issue.id).filter((id) => mine.has(id));
    expect(page).toEqual(picker);
    return picker;
  };
  // Finishing the child frees the epic, so the ready order (readyNow) puts it first; no second rule does.
  expect(order()).toEqual([child.id, older.id]);
  expect(putFirst(app, alice, fresh(), getIssueById(app.db, older.id)!).ok).toBe(true);
  expect(order()).toEqual([older.id, child.id]);
  // Clean up so the drives below see the same open work as before.
  for (const i of [older, epic, child]) app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(i.id);
  opened.splice(opened.length - 3, 3);
});

test("slots.smallShare set on /settings/capacity changes the pick: 0 starts no small issue, 100 does; out of range is refused", async () => {
  // The earlier ticks filled the slots; those runs end so this pick has room.
  app.db.query("UPDATE run SET state = 'ok' WHERE repo_id = ?1 AND state IN ('queued','running')").run(repo.id);
  const small = open("A test pins the colour");
  expect((await setShare("0")).status).toBe(303);
  expect(smallShare(app.db)).toBe(0);
  expect(await drive(opened)).toEqual([]);
  expect(getIssueById(app.db, small.id)!.assigneeId).toBeNull();
  expect((await setShare("100")).status).toBe(303);
  expect(smallShare(app.db)).toBe(100);
  const picked = await drive(opened);
  expect(picked.length).toBeGreaterThan(0);
  for (const i of picked) expect(isSmall(i.title, [])).toBe(true);
  for (const value of ["101", "-1", "half"]) {
    await setShare(value);
    expect(smallShare(app.db)).toBe(100);
  }
});
