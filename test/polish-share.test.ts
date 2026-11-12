/**
 * The polish share (#8853): a stored per-repository setting, 10% to start and
 * 0–50 allowed; polish (issues labelled `polish`, or in the small-fixes lane)
 * is picked while it has spent less than its share of the week's agent spend
 * and not once it is over; the week page and the `week` tool show where it stands.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue, setIssueLabels } from "../src/actions/issues.ts";
import { commitToBranch, createLabel, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { driveRepo } from "../src/crew/autonomy.ts";
import { isPolish, polishPosition, polishSpend, polishWords, validPolishShare } from "../src/crew/polish_share.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the rules", () => {
  test("polish is the label or the small-fixes lane; a feature is not", () => {
    expect(isPolish("Nudge the margin", ["Polish"])).toBe(true);
    expect(isPolish("A test pins the title", [])).toBe(true);
    expect(isPolish("Search notes", ["feature"])).toBe(false);
  });

  test("by hand: $1 of $20 is 5%, under a 10% share; $2 of $20 is exactly 10%, no longer under; 0% is never under", () => {
    expect(polishPosition(1, 20, 10)).toMatchObject({ percent: 5, under: true });
    expect(polishPosition(2, 20, 10)).toMatchObject({ percent: 10, under: false });
    expect(polishPosition(3, 20, 10).under).toBe(false);
    expect(polishPosition(0, 0, 10).under).toBe(true);
    expect(polishPosition(0, 0, 0).under).toBe(false);
    expect(polishWords(polishPosition(1, 20, 10))).toContain("polish 5.0% of 10% this week ($1.00 of $20.00)");
  });

  test("the share is a whole number 0 to 50", () => {
    for (const ok of [0, 10, 50]) expect(validPolishShare(ok)).toBe(true);
    for (const bad of [-1, 51, 1.5, Number.NaN, "10", null]) expect(validPolishShare(bad)).toBe(false);
  });
});

let dataDir: string;
let app: App;
let alice: User;
let repo: Repo;
let servers: Servers;
let cookie: string;
const fresh = () => getRepoById(app.db, repo.id)!;

function open(title: string): Issue {
  const made = openIssue(app, alice, fresh(), { title });
  if (!made.ok) throw new Error(String(made.error));
  return made.value;
}

/** An issue already done, so the spend on it leaves nothing stalled to pick. */
function done(title: string, label?: string): Issue {
  const issue = open(title);
  if (label !== undefined) expect(setIssueLabels(app, alice, fresh(), issue, [label]).ok).toBe(true);
  app.db.query("UPDATE issue SET state = 'closed', close_reason = 'done' WHERE id = ?1").run(issue.id);
  return issue;
}

/** An agent run on `issue` that cost `usd` and started at `at`. */
function spend(issue: Issue, usd: number, at: Date): void {
  const run = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: issue.id, actorId: alice.id, reason: "assigned" });
  app.db.query("UPDATE run SET state = 'ok', cost_usd = ?2, started_at = ?3 WHERE id = ?1").run(run.id, usd, at.toISOString());
}

const NOW = new Date("2030-03-13T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

/** One tick at `now`: the issues it assigned, if any. */
async function drive(issues: readonly Issue[], now: Date): Promise<Issue[]> {
  await driveRepo(app, fresh(), now);
  return issues.map((i) => getIssueById(app.db, i.id)!).filter((i) => i.assigneeId !== null);
}

const clear = () => app.db.query("DELETE FROM run WHERE repo_id = ?1").run(repo.id);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-polish-share-"));
  app = createApp({ dataDir, port: 0 });
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
    files: [{ path: "package.json", content: `{"name":"notes"}\n` }],
  });
  if (!first.ok) throw new Error(JSON.stringify(first.error));
  for (const name of ["b1", "b2"]) {
    const agent = await createAgent(app, alice, { username: name });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, repo, name).ok).toBe(true);
  }
  const on = await updateRepoSettings(app, alice, repo, {
    autonomy: "autonomous", autonomyDirection: "Keep the notes tidy.", autonomyCeilingUsd: 100, autonomySlots: 2, autonomyBy: alice.id,
  });
  expect(on.ok).toBe(true);
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST", redirect: "manual",
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

test("a repository starts at 10%; the share saves from 0 to 50 and nothing else", async () => {
  expect(fresh().polishShare).toBe(10);
  for (const bad of [51, -1, 2.5, Number.NaN]) {
    const refused = await updateRepoSettings(app, alice, fresh(), { polishShare: bad });
    expect(refused).toEqual({ ok: false, error: "polish_share" });
  }
  expect(fresh().polishShare).toBe(10);
  expect((await updateRepoSettings(app, alice, fresh(), { polishShare: 50 })).ok).toBe(true);
  expect(fresh().polishShare).toBe(50);
  expect((await updateRepoSettings(app, alice, fresh(), { polishShare: 10 })).ok).toBe(true);
});

test("the settings page shows the line with its reason, and its form saves it or says why not", async () => {
  const page = await (await fetch(`${servers.url}/alice/notes/settings`, { headers: { cookie } })).text();
  expect(page).toMatch(/name="polishShare"[^>]*value="10"/);
  expect(page).toContain("Percent of the week's agent spend that polish may take");
  const save = (value: string) =>
    fetch(`${servers.url}/alice/notes/settings`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ card: "gates", polishShareShown: "1", polishShare: value }),
    });
  expect((await save("20")).status).toBe(303);
  expect(fresh().polishShare).toBe(20);
  await save("99");
  await save("abc");
  expect(fresh().polishShare).toBe(20);
  await save("10");
});

test("dispatch picks a ready polish issue under its share and stops once over, on a fake clock", async () => {
  clear();
  createLabel(app, alice, fresh(), "polish", "888888");
  const polish = open("Nudge the margins");
  expect(setIssueLabels(app, alice, fresh(), polish, ["polish"]).ok).toBe(true);
  const feature = done("Search notes by word");
  const older = done("Tidy the footer", "polish");

  // $0.50 of $9.50 is 5%: under the 10% share.
  spend(feature, 9, daysAgo(2));
  spend(older, 0.5, daysAgo(1));
  expect(polishSpend(app.db, repo.id, 10, NOW).under).toBe(true);
  expect((await drive([polish], NOW)).map((i) => i.id)).toEqual([polish.id]);

  // Polish at $3 of $12 is 25%: over. The same ready issue is left alone.
  app.db.query("UPDATE issue SET assignee_id = NULL WHERE id = ?1").run(polish.id);
  clear();
  spend(feature, 9, daysAgo(2));
  spend(older, 3, daysAgo(1));
  expect(polishSpend(app.db, repo.id, 10, NOW)).toMatchObject({ polishUsd: 3, totalUsd: 12, under: false });
  expect(await drive([polish], NOW)).toEqual([]);

  // Eight days later that spend has left the window: the clock alone makes it pickable again.
  const later = new Date(NOW.getTime() + 8 * 86_400_000);
  expect(polishSpend(app.db, repo.id, 10, later).under).toBe(true);
  expect((await drive([polish], later)).map((i) => i.id)).toEqual([polish.id]);
});

test("the small-fixes lane counts as polish, and what the owner raised is not held back", async () => {
  clear();
  app.db.query("UPDATE issue SET state = 'closed', close_reason = 'done' WHERE repo_id = ?1 AND assignee_id IS NULL").run(repo.id);
  const lane = open("A test pins the tags");
  const old = done("A test pins the body");
  spend(done("Export notes"), 5, daysAgo(1));
  spend(old, 5, daysAgo(1));
  expect(polishSpend(app.db, repo.id, 10, NOW).under).toBe(false);
  expect(await drive([lane], NOW)).toEqual([]);
  app.db.query("INSERT INTO issue_raise (issue_id, raised_at) VALUES (?1, ?2)").run(lane.id, NOW.toISOString());
  expect((await drive([lane], NOW)).map((i) => i.id)).toEqual([lane.id]);
});

test("the week page and the week tool show polish spent against the share", async () => {
  clear();
  const polish = open("A test pins the date");
  const feature = open("Export notes");
  const now = new Date();
  spend(feature, 9, new Date(now.getTime() - 86_400_000));
  spend(polish, 1, new Date(now.getTime() - 86_400_000));
  const page = await (await fetch(`${servers.url}/alice/notes/week`, { headers: { cookie } })).text();
  expect(page).toContain("10.0% of 10%");
  expect(page).toContain("($1.00 of $10.00)");
  expect(page).toContain("no polish starts until it is under");
});
