/**
 * A crew pull conflicted for 72 hours with no push is closed by the conflict
 * sweep (#5940); a person's, a held one, and one approved on its head are
 * left alone.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { listEvents } from "../src/core/events.ts";
import { setHold } from "../src/core/holds.ts";
import { getIssueById, listComments } from "../src/core/issues.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { sweepConflicts } from "../src/crew/autonomy.ts";
import { closedLine, closedToday } from "../src/crew/stale_pulls.ts";

let dataDir: string;
let app: App;
let alice: User;
let mason: User;
let repo: Repo;
let n = 0;

const HOUR = 3_600_000;
const T0 = new Date();
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);
/** One sweep at `hours` after T0; queued runs are cleared so the sweep reaches the 72-hour rule. */
async function sweep(hours: number): Promise<void> {
  app.db.query("DELETE FROM run").run();
  await sweepConflicts(app, getRepoById(app.db, repo.id)!, at(hours));
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-stale-pulls-"));
  app = createApp({ dataDir, port: 0 });
  const a = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
  const made = await createRepo(app, alice, { name: "engine", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const seeded = await commitToBranch(app, alice, repo, {
    message: "Start",
    files: [{ path: "shared.ts", content: "export const shared = 0;\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  const agent = await createAgent(app, alice, { username: "mason" });
  if (!agent.ok) throw new Error(String(agent.error));
  expect(addToCrew(app, alice, repo, "mason").ok).toBe(true);
  mason = getUserByName(app.db, "mason")!;
  app.db
    .query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1")
    .run(repo.id, alice.id);
});

afterAll(async () => {
  app.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** An open pull by `who` that closes a fresh issue assigned to mason. */
async function pullBy(who: User) {
  const k = ++n;
  const ask = openIssue(app, alice, repo, { title: `Ask ${k}` });
  if (!ask.ok) throw new Error(String(ask.error));
  app.db.query("UPDATE issue SET assignee_id = ?2 WHERE id = ?1").run(ask.value.id, mason.id);
  const branch = await commitToBranch(app, alice, repo, {
    branch: `feature/s${k}`,
    base: "main",
    message: `Shared ${k}`,
    files: [{ path: "shared.ts", content: `export const shared = 'branch ${k}';\n` }],
  });
  if (!branch.ok) throw new Error(JSON.stringify(branch.error));
  const opened = await openPull(app, who, repo, {
    title: `Shared ${k}`,
    body: `Closes #${ask.value.number}`,
    baseBranch: "main",
    headBranch: `feature/s${k}`,
  });
  if (!opened.ok) throw new Error(String(opened.error));
  // Main moves under it, on the same line.
  const moved = await commitToBranch(app, alice, repo, {
    branch: "main",
    message: `Shared ${k}, main's way`,
    files: [{ path: "shared.ts", content: `export const shared = 'main ${k}';\n` }],
  });
  if (!moved.ok) throw new Error(JSON.stringify(moved.error));
  return { pull: opened.value, ask: ask.value };
}

const open = (id: string) => getIssueById(app.db, id)!.state === "open";

test("a 73-hour crew pull is closed with one line and its issue made ready; 71 hours is not", async () => {
  const { pull, ask } = await pullBy(mason);
  await sweep(0);
  await sweep(71);
  expect(open(pull.id)).toBe(true);
  expect(getIssueById(app.db, ask.id)!.assigneeId).toBe(mason.id);

  await sweep(73);
  expect(open(pull.id)).toBe(false);
  const freed = getIssueById(app.db, ask.id)!;
  expect(freed.state).toBe("open");
  expect(freed.assigneeId).toBeNull();
  expect(listComments(app.db, pull.id).map((c) => c.body)).toContain(closedLine(ask.number));
  expect(closedLine(ask.number)).toBe(
    `Closed after 3 days in conflict; #${ask.number} is ready again and will be built fresh from main.`,
  );
  // One close event, with the stale mark on it, and no second kind.
  const closes = listEvents(app.db, { repoId: repo.id, kind: "pull.closed" }).filter(
    (e) => e.payload.number === pull.number,
  );
  expect(closes.length).toBe(1);
  expect(closes[0]!.payload.stale).toBe(true);
  expect(closedToday(app, repo.id)).toBe(1);
  // The branch is kept.
  expect(getPull(app.db, repo.id, pull.number)!.headBranch).toBe(`feature/s${n}`);
});

test("a person's pull, a held pull and a crew pull approved on its head are never closed", async () => {
  const person = await pullBy(alice);
  const held = await pullBy(mason);
  const approved = await pullBy(mason);
  await sweep(1000);
  setHold(app.db, held.pull.id, alice.id, "wait for the design");
  submitReview(app.db, {
    issueId: approved.pull.id,
    authorId: alice.id,
    state: "approved",
    commitOid: approved.pull.headOid,
  });
  await sweep(1100);
  expect(open(person.pull.id)).toBe(true);
  expect(open(held.pull.id)).toBe(true);
  expect(open(approved.pull.id)).toBe(true);
  expect(getIssueById(app.db, approved.ask.id)!.assigneeId).toBe(mason.id);
});

test("a push moves the head and the 72 hours start again", async () => {
  const { pull } = await pullBy(mason);
  const branch = `feature/s${n}`;
  await sweep(2000);
  const pushed = await commitToBranch(app, alice, repo, {
    branch,
    message: "Pushed again",
    files: [{ path: "shared.ts", content: "export const shared = 'pushed';\n" }],
  });
  if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
  expect(getPull(app.db, repo.id, pull.number)!.headOid).not.toBe(pull.headOid);
  await sweep(2060);
  // 73 hours after the first sighting, but only 13 after the push.
  await sweep(2073);
  expect(open(pull.id)).toBe(true);
  await sweep(2060 + 73);
  expect(open(pull.id)).toBe(false);
});
