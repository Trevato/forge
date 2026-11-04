/**
 * The finishing pass reads every open pull, not the newest page (#6263):
 * an approved, conflicted pull older than fifty newer ones is still brought
 * up to date. Its entry and every pull it drops are logged once per reason,
 * and with no candidate the tick line says `0 candidates of N open`.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import {} from "../src/core/agents.ts";
import { createRun } from "../src/core/runs.ts";
import type { Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { finishApproved, finishFields, type FinishPass } from "../src/crew/finishing.ts";

const NEWER = 50;

let dataDir: string;
let app: App;
let alice: User;
let repo: Repo;
let oldest: Pull;

/** One finishing pass with `free` slots, and the lines it logged about its pulls. */
async function pass(free: number): Promise<{ pass: FinishPass; lines: string[] }> {
  const lines: string[] = [];
  const spy = spyOn(console, "info").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  try {
    const done = await finishApproved(app, getRepoById(app.db, repo.id)!, free);
    return { pass: done, lines: lines.filter((l) => l.includes("finishing: ") || l.includes("approved pull conflicts")) };
  } finally {
    spy.mockRestore();
  }
}

async function pullOn(n: number, content: string): Promise<Pull> {
  const branch = await commitToBranch(app, alice, repo, {
    branch: `feature/${n}`,
    base: "main",
    message: `Branch ${n}`,
    files: [{ path: `file-${n}.ts`, content }],
  });
  if (!branch.ok) throw new Error(JSON.stringify(branch.error));
  const opened = await openPull(app, getUserByName(app.db, "mason")!, repo, {
    title: `Branch ${n}`,
    body: "",
    baseBranch: "main",
    headBranch: `feature/${n}`,
  });
  if (!opened.ok) throw new Error(String(opened.error));
  return opened.value;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-finishing-pages-"));
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
    files: [{ path: "file-0.ts", content: "export const zero = 0;\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  for (const name of ["mason", "quill"]) {
    const agent = await createAgent(app, alice, { username: name });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, repo, name).ok).toBe(true);
  }
  seatAs(app.db, repo.id, getUserByName(app.db, "quill")!.id, "reviewer");
  // The oldest pull edits the file main is about to change; fifty newer
  // ones each add their own file and merge clean.
  oldest = await pullOn(0, "export const zero = 'branch';\n");
  for (let n = 1; n <= NEWER; n++) await pullOn(n, `export const n = ${n};\n`);
  const approved = submitReview(app.db, {
    issueId: oldest.id,
    authorId: getUserByName(app.db, "quill")!.id,
    state: "approved",
    commitOid: oldest.headOid,
  });
  if (!approved.ok) throw new Error(approved.error);
  app.db
    .query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2, autonomy_slots = 1 WHERE id = ?1")
    .run(repo.id, alice.id);
}, 60_000);

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("with no candidate the tick line still says how many open pulls were read", async () => {
  const { pass: done, lines } = await pass(0);
  expect(done.moves).toEqual([]);
  expect(done.open).toBe(NEWER + 1);
  expect(finishFields(done.moves, undefined, done.open).finishing).toBe(`0 candidates of ${NEWER + 1} open`);
  expect(lines.some((l) => l.includes("finishing: pass") && l.includes(`open=${NEWER + 1} free=0`))).toBe(true);
  // Every pull the pass drops is said, with the filter that dropped it.
  const drops = lines.filter((l) => l.includes("finishing: drop"));
  expect(drops).toHaveLength(NEWER + 1);
  expect(drops.find((l) => l.includes(`pull=${oldest.number} `))).toContain('why="merges clean"');
  expect(drops.find((l) => l.includes(`pull=${NEWER + 1} `))).toContain('why="not approved on its head"');
});

test("said once per pull and reason: the same pass again logs nothing", async () => {
  const { lines } = await pass(0);
  expect(lines).toEqual([]);
});

test("an approved, conflicted pull older than fifty newer ones is brought up to date, by its busy author", async () => {
  // Its author is busy and another builder idle: the update still goes to
  // the author, who can push the branch, queued behind that run (#7006).
  const torque = await createAgent(app, alice, { username: "torque" });
  if (!torque.ok) throw new Error(String(torque.error));
  expect(addToCrew(app, alice, repo, "torque").ok).toBe(true);
  const elsewhere = await pullOn(NEWER + 1, "export const busy = 1;\n");
  createRun(app.db, {
    repoId: repo.id,
    kind: "agent",
    issueId: elsewhere.id,
    actorId: getUserByName(app.db, "mason")!.id,
    reason: "assigned",
  });
  const moved = await commitToBranch(app, alice, repo, {
    branch: "main",
    message: "Zero, main's way",
    files: [{ path: "file-0.ts", content: "export const zero = 'main';\n" }],
  });
  if (!moved.ok) throw new Error(JSON.stringify(moved.error));
  const { pass: done, lines } = await pass(1);
  expect(done.moves).toEqual([{ pull: oldest.number, did: "queued update", builder: "mason" }]);
  expect(finishFields(done.moves, undefined, done.open).finishing).toBe("queued 1, in flight 0, skipped 0");
  expect(lines.some((l) => l.includes("finishing: pass") && l.includes("free=1"))).toBe(true);
  expect(lines.some((l) => l.includes("approved pull conflicts: brought up to date first"))).toBe(true);
});
