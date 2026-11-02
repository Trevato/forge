/**
 * What counts toward the two failed updates that hand an approved,
 * conflicted pull to a person (#6263): only a run that reached the agent
 * and ended without a push. A run the forge cut short — a network error, a
 * checkout that failed — is no attempt, and a new base is a new chance.
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
import type { Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { claimRun, finishRun, listRuns } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { finishApproved, type FinishMove } from "../src/crew/finishing.ts";
import { interruptionOf } from "../src/crew/interrupted.ts";

let dataDir: string;
let app: App;
let alice: User;
let repo: Repo;
let pull: Pull;

async function pass(): Promise<FinishMove[]> {
  const spy = spyOn(console, "info").mockImplementation(() => {});
  try {
    return (await finishApproved(app, getRepoById(app.db, repo.id)!, 1)).moves;
  } finally {
    spy.mockRestore();
  }
}

/** The queued update on the pull, ended with `summary`. */
function end(summary: string): void {
  const run = listRuns(app.db, repo.id, { kind: "agent" }).find(
    (r) => r.issueId === pull.id && r.state === "queued",
  );
  expect(run).toBeDefined();
  claimRun(app.db, run!.id);
  finishRun(app.db, run!.id, { state: "failed", summary });
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-finishing-attempts-"));
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
  const quill = getUserByName(app.db, "quill")!;
  seatAs(app.db, repo.id, quill.id, "reviewer");
  const branch = await commitToBranch(app, alice, repo, {
    branch: "feature/1",
    base: "main",
    message: "Shared, the branch's way",
    files: [{ path: "shared.ts", content: "export const shared = 1;\n" }],
  });
  if (!branch.ok) throw new Error(JSON.stringify(branch.error));
  const opened = await openPull(app, getUserByName(app.db, "mason")!, repo, {
    title: "Shared the branch's way",
    body: "",
    baseBranch: "main",
    headBranch: "feature/1",
  });
  if (!opened.ok) throw new Error(String(opened.error));
  pull = opened.value;
  const approved = submitReview(app.db, {
    issueId: pull.id,
    authorId: quill.id,
    state: "approved",
    commitOid: pull.headOid,
  });
  if (!approved.ok) throw new Error(approved.error);
  const moved = await commitToBranch(app, alice, repo, {
    branch: "main",
    message: "Shared, main's way",
    files: [{ path: "shared.ts", content: "export const shared = 'main';\n" }],
  });
  if (!moved.ok) throw new Error(JSON.stringify(moved.error));
  app.db
    .query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2, autonomy_slots = 1 WHERE id = ?1")
    .run(repo.id, alice.id);
}, 30_000);

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the runner's own clone, fetch and checkout failures are interruptions", () => {
  expect(interruptionOf("checkout failed: fatal: not a git repository")).toBe("clone");
  expect(interruptionOf("fetch failed: fatal: unable to access")).toBe("clone");
  expect(interruptionOf("fetch from the fork failed: fatal: x")).toBe("clone");
  expect(interruptionOf("declined: the checkout failed: is not mine")).toBe(undefined);
});

test("a network error and a failed checkout are no attempt: the update is queued again", async () => {
  expect((await pass())[0]).toMatchObject({ did: "queued update", builder: "mason" });
  end("interrupted: network error, resumes on the next pass — the run failed: TypeError: fetch failed");
  expect((await pass())[0]).toMatchObject({ did: "queued update" });
  end("checkout failed: fatal: not a git repository");
  expect((await pass())[0]).toMatchObject({ did: "queued update" });
  end("could not merge");
});

test("a new base is a new chance: failed updates before main moved do not count", async () => {
  // The runs above were hours before main moves again, as the frozen pulls'
  // were — and outside the breaker's window (`breaker.ts`).
  app.db
    .query("UPDATE run SET created_at = ?2 WHERE issue_id = ?1")
    .run(pull.id, new Date(Date.now() - 2 * 60 * 60_000).toISOString());
  const moved = await commitToBranch(app, alice, repo, {
    branch: "main",
    message: "Shared, main's way again",
    files: [{ path: "shared.ts", content: "export const shared = 'main, again';\n" }],
  });
  if (!moved.ok) throw new Error(JSON.stringify(moved.error));
  expect((await pass())[0]).toMatchObject({ did: "queued update" });
  end("could not merge");
  expect((await pass())[0]).toMatchObject({ did: "queued update" });
  end("could not merge");
  // Two that reached the agent on this base: a person's now.
  expect((await pass())[0]).toEqual({ pull: pull.number, did: "handed to a person", to: "alice" });
});
