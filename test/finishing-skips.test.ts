/**
 * The finishing pass says why it skips each approved, conflicted pull
 * (#6237): one `finishing: skip pull=N why="…"` line per pull, said again
 * only when the reason changes, and the tick line's
 * `finishing="queued Q, in flight F, skipped S: <why>×k"`.
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
import { setCapacity } from "../src/core/capacity.ts";
import { setHold } from "../src/core/holds.ts";
import type { Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { createRun, listRuns } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { finishApproved, finishFields, type FinishMove } from "../src/crew/finishing.ts";
import { NO_BUILDER_ON_CREW, WAITS_FOR_BUILDER_SLOT } from "../src/crew/words.ts";
import { conflictedPulls } from "../src/flow/conflicted.ts";

let dataDir: string;
let app: App;
let alice: User;
let repo: Repo;
const pulls: Pull[] = [];

/** One finishing pass with `free` slots, its moves and the skip lines it logged. */
async function pass(free: number): Promise<{ moves: FinishMove[]; skips: string[] }> {
  const lines: string[] = [];
  const spy = spyOn(console, "info").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  try {
    const { moves } = await finishApproved(app, getRepoById(app.db, repo.id)!, free);
    return { moves, skips: lines.filter((l) => l.includes("finishing: skip")) };
  } finally {
    spy.mockRestore();
  }
}

const skipOf = (skips: readonly string[], n: number) => skips.filter((l) => l.includes(`pull=${n} `));

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-finishing-skips-"));
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
  for (const name of ["mason", "quill"]) {
    const agent = await createAgent(app, alice, { username: name });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, repo, name).ok).toBe(true);
  }
  const mason = getUserByName(app.db, "mason")!;
  const quill = getUserByName(app.db, "quill")!;
  seatAs(app.db, repo.id, quill.id, "reviewer");
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
  // #1 is held, #2 is a person's, #3 is the crew's to bring up to date.
  setHold(app.db, pulls[0]!.id, alice.id, "not yet");
  app.db.query("UPDATE issue SET assignee_id = ?2 WHERE id = ?1").run(pulls[1]!.id, alice.id);
  app.db
    .query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2, autonomy_slots = 1 WHERE id = ?1")
    .run(repo.id, alice.id);
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("each skipped pull is logged with its reason, and the tick line tallies them", async () => {
  const { moves, skips } = await pass(0);
  expect(skips).toHaveLength(3);
  expect(skipOf(skips, 1)[0]).toContain('finishing: skip pull=1 why="held by alice"');
  expect(skipOf(skips, 2)[0]).toContain('finishing: skip pull=2 why="a person has it"');
  expect(skipOf(skips, 3)[0]).toContain(`finishing: skip pull=3 why=${JSON.stringify(WAITS_FOR_BUILDER_SLOT)}`);
  expect(finishFields(moves).finishing).toBe(
    `queued 0, in flight 0, skipped 3: held by alice×1, a person has it×1, ${WAITS_FOR_BUILDER_SLOT}×1`,
  );
  // The held pull is still approved and conflicted: the lane counts it.
  expect(finishFields(moves, { runs: 0, checks: 0, room: 1 }).lane).toBe("conflicted 3, rebasing 0, room 1");
  expect(conflictedPulls(app.db).map((p) => p.number)).toContain(1);
});

test("said once per pull: a pass with the same reasons logs nothing", async () => {
  const { moves, skips } = await pass(0);
  expect(moves).toHaveLength(3);
  expect(skips).toEqual([]);
});

test("a changed reason is said again, for that pull only", async () => {
  // One check at a time, and a rebase already in it: no room in the lane.
  setCapacity(app.db, "checks.concurrency", "1", alice.id);
  createRun(app.db, { repoId: repo.id, kind: "agent", issueId: pulls[0]!.id, reason: "conflict" });
  const full = await pass(1);
  expect(full.skips).toHaveLength(1);
  expect(full.skips[0]).toContain('finishing: skip pull=3 why="waits for room in the check lane"');
  expect(listRuns(app.db, repo.id, { kind: "agent" }).filter((r) => r.issueId === pulls[2]!.id)).toHaveLength(0);

  seatAs(app.db, repo.id, getUserByName(app.db, "mason")!.id, "reviewer");
  const none = await pass(1);
  expect(none.skips).toHaveLength(1);
  expect(none.skips[0]).toContain(`finishing: skip pull=3 why=${JSON.stringify(NO_BUILDER_ON_CREW)}`);
});
