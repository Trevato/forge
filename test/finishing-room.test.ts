/**
 * The finishing pass asks the check lane for room, as the conflict sweep
 * does (#4784): a landing that conflicts several approved pulls at once
 * queues no more bring-up-to-date runs — each a push, each a check — than
 * the lane has slots for, however many builder slots are free.
 */
import { quietWeek } from "./helpers/week-quiet.ts";
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
import { setCapacity } from "../src/core/capacity.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { createRun, listRuns } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { autonomyTick } from "../src/crew/autonomy.ts";

let dataDir: string;
let app: App;
let alice: User;
let repo: Repo;
const pulls: Pull[] = [];
const conflicts = () =>
  listRuns(app.db, repo.id, { kind: "agent" }).filter(
    (r) => r.reason === "conflict" && pulls.some((p) => p.id === r.issueId),
  );

async function tick(): Promise<void> {
  const spy = spyOn(console, "info").mockImplementation(() => {});
  try {
    // Seven hours on, the governor's flow windows hold nothing: the lane, not the pile, limits (#6375).
    await autonomyTick(app, new Date(Date.now() + 7 * 3_600_000), async () => 0);
  } finally {
    spy.mockRestore();
  }
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-finishing-room-"));
  app = createApp({ dataDir, port: 0 });
  quietWeek(app.db);
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
  for (const name of ["mason", "quill"]) {
    const agent = await createAgent(app, alice, { username: name });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, repo, name).ok).toBe(true);
  }
  const mason = getUserByName(app.db, "mason")!;
  const quill = getUserByName(app.db, "quill")!;
  seatAs(app.db, repo.id, quill.id, "reviewer");

  // Three approved pulls that all touch the file main is about to change.
  for (const n of [1, 2, 3]) {
    const branch = await commitToBranch(app, alice, repo, {
      branch: `feature/${n}`,
      base: "main",
      message: `Shared, branch ${n}'s way`,
      files: [{ path: "shared.ts", content: `export const shared = ${n};\n` }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, mason, repo, {
      title: `Shared the way of ${n}`,
      body: "",
      baseBranch: "main",
      headBranch: `feature/${n}`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    pulls.push(opened.value);
    const approved = submitReview(app.db, {
      issueId: opened.value.id,
      authorId: quill.id,
      state: "approved",
      commitOid: opened.value.headOid,
    });
    if (!approved.ok) throw new Error(approved.error);
  }
  const moved = await commitToBranch(app, alice, repo, {
    branch: "main",
    message: "Shared, main's way",
    files: [{ path: "shared.ts", content: "export const shared = 'main';\n" }],
  });
  if (!moved.ok) throw new Error(JSON.stringify(moved.error));
  await Bun.sleep(5);
  // Builder slots for all three: the lane, not the crew, is what limits.
  app.db
    .query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2, autonomy_slots = 3 WHERE id = ?1")
    .run(repo.id, alice.id);
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a full lane takes one approved pull's update, not one per free builder slot", async () => {
  setCapacity(app.db, "checks.concurrency", "1", alice.id);
  createRun(app.db, { repoId: repo.id, kind: "check", env: "main", reason: "push" });
  await tick();
  expect(conflicts()).toHaveLength(1);
  // That one is in flight and the lane is still full: nothing more.
  await tick();
  expect(conflicts()).toHaveLength(1);
});

test("once the lane has slots, the rest are brought up to date", async () => {
  setCapacity(app.db, "checks.concurrency", "8", alice.id);
  await tick();
  expect(new Set(conflicts().map((r) => r.issueId))).toEqual(new Set(pulls.map((p) => p.id)));
});
