/**
 * Finish before starting (#3682): with one slot, an approved pull that no
 * longer merges is brought up to date before a ready issue is picked; two
 * updates that end without a push hand it to a person, on their review
 * list, instead of closing it or trying again.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import {} from "../src/core/agents.ts";
import { getIssueById, listComments, type Issue } from "../src/core/issues.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { claimRun, finishRun, listRuns } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { autonomyTick } from "../src/crew/autonomy.ts";
import { finishFields } from "../src/crew/finishing.ts";
import { HANDOVER_NOTE } from "../src/crew/guard.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let mason: User;
let repo: Repo;
let pull: Pull;
let ready: Issue;
const conflicts = () =>
  listRuns(app.db, repo.id, { kind: "agent" }).filter((r) => r.issueId === pull.id && r.reason === "conflict");
const picked = () => listRuns(app.db, repo.id, { kind: "agent" }).filter((r) => r.issueId === ready.id);

/** One tick, with the green sweep left out, and the tick line it said. */
async function tick(): Promise<string> {
  const lines: string[] = [];
  const spy = spyOn(console, "info").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  try {
    await autonomyTick(app, new Date(), async () => 0);
  } finally {
    spy.mockRestore();
  }
  return lines.find((l) => l.includes("[autonomy] tick") && l.includes("did=")) ?? "";
}

const fail = (id: string) => {
  claimRun(app.db, id);
  finishRun(app.db, id, { state: "failed", summary: "could not merge" });
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-finishing-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
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
  mason = getUserByName(app.db, "mason")!;
  const quill = getUserByName(app.db, "quill")!;
  seatAs(app.db, repo.id, quill.id, "reviewer");

  const branch = await commitToBranch(app, alice, repo, {
    branch: "feature/shared",
    base: "main",
    message: "Shared, the branch's way",
    files: [{ path: "shared.ts", content: "export const shared = 'branch';\n" }],
  });
  if (!branch.ok) throw new Error(JSON.stringify(branch.error));
  const opened = await openPull(app, mason, repo, {
    title: "Shared the branch's way",
    body: "",
    baseBranch: "main",
    headBranch: "feature/shared",
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
  const issue = openIssue(app, alice, repo, { title: "Something new" });
  if (!issue.ok) throw new Error(String(issue.error));
  ready = issue.value;
  await Bun.sleep(5);
  app.db
    .query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2, autonomy_slots = 1 WHERE id = ?1")
    .run(repo.id, alice.id);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("with one slot, the approved conflicted pull is brought up to date before the ready issue is picked", async () => {
  const line = await tick();
  expect(conflicts()).toHaveLength(1);
  expect(conflicts()[0]!.actorId).toBe(mason.id);
  expect(conflicts()[0]!.summary).toBe("main moved: shared.ts");
  expect(picked()).toHaveLength(0);
  expect(getIssueById(app.db, ready.id)!.assigneeId).toBeNull();
  expect(line).toContain("did=full");
  expect(line).toContain('finishing="queued 1, in flight 0, skipped 0"');
  // In flight: the next tick queues no second, and still picks nothing.
  await tick();
  expect(conflicts()).toHaveLength(1);
  expect(picked()).toHaveLength(0);
});

test("two updates that end without a push hand the pull to a person, open and on their review list", async () => {
  fail(conflicts()[0]!.id);
  await tick();
  expect(conflicts()).toHaveLength(2);
  expect(picked()).toHaveLength(0);

  fail(conflicts().find((r) => r.state === "queued")!.id);
  const line = await tick();
  // Not closed by the conflict sweep, not tried a third time: a person's.
  const after = getIssueById(app.db, pull.id)!;
  expect(after.state).toBe("open");
  expect(after.assigneeId).toBe(alice.id);
  expect(conflicts()).toHaveLength(2);
  const notes = listComments(app.db, pull.id).filter((c) => c.body.startsWith(HANDOVER_NOTE));
  expect(notes).toHaveLength(1);
  expect(notes[0]!.body).toContain("shared.ts");
  expect(line).toContain('finishing="queued 0, in flight 0, skipped 1: handed to a person×1"');
  // The slot it no longer needs goes to the ready issue.
  expect(getIssueById(app.db, ready.id)!.assigneeId).toBe(mason.id);

  // Said once: another tick adds no second note and no run.
  await tick();
  expect(listComments(app.db, pull.id).filter((c) => c.body.startsWith(HANDOVER_NOTE))).toHaveLength(1);
  expect(conflicts()).toHaveLength(2);

  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
  });
  const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const asks = await (await fetch(`${servers.url}/asks`, { headers: { cookie } })).text();
  expect(asks).toContain("Shared the branch&#39;s way");
});

test("the tick line's field: finishing counts what moves, and tallies why the rest wait", () => {
  expect(finishFields([])).toEqual({});
  expect(
    finishFields([
      { pull: 1, did: "queued update", builder: "mason" },
      { pull: 2, did: "in flight" },
      { pull: 3, did: "not moved", why: "waits for a builder slot" },
      { pull: 4, did: "handed to a person", to: "alice" },
      { pull: 5, did: "not moved", why: "waits for a builder slot" },
    ]),
  ).toEqual({
    finishing: "queued 1, in flight 1, skipped 3: waits for a builder slot×2, handed to a person×1",
  });
});
