/**
 * Lifting an issue from Later makes it startable (#8924): the one action
 * leaves it reachable by the picker, under a pillar when it named none, and
 * the tick and Next up say why any ready issue is not startable.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import { liftHold } from "../src/actions/gate.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { readyNow, repoGraph } from "../src/core/dependencies.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { pillarsOf, servedBy } from "../src/core/pillars.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { nextUp } from "../src/core/next_up.ts";
import { createRun } from "../src/core/runs.ts";
import { notStartable } from "../src/crew/not_startable.ts";
import { driveRepo } from "../src/crew/autonomy.ts";
import { passedWords } from "../src/crew/pick_filter.ts";
import { heldNow } from "../src/crew/held.ts";
import { releaseFromGate } from "../src/crew/release_later.ts";

let dataDir: string;
let app: App;
let alice: User;
let bob: User;
let repo: Repo;
let gate: Issue;

const fresh = () => getRepoById(app.db, repo.id)!;
const current = (i: Issue) => getIssueById(app.db, i.id)!;
const open = (who: User, title: string): Issue => {
  const made = openIssue(app, who, fresh(), { title });
  if (!made.ok) throw new Error(String(made.error));
  return made.value;
};
const readyNumbers = () => readyNow(repoGraph(app.db, repo.id, { sealed: true })).map((r) => r.issue.number);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-lift-startable-"));
  app = createApp({ dataDir, port: 0 });
  const a = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
  const b = await createUser(app.db, {
    origin: "seed", trusted: true, username: "bob", email: "bob@forge.local",
    password: "a-good-passphrase",
  });
  if (!b.ok) throw new Error(b.error);
  bob = b.value;
  const made = await createRepo(app, alice, { name: "notes", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const first = await commitToBranch(app, alice, repo, {
    message: "Start",
    files: [{ path: "package.json", content: `{"name":"notes"}\n` }],
  });
  if (!first.ok) throw new Error(JSON.stringify(first.error));
  const agent = await createAgent(app, alice, { username: "b1" });
  if (!agent.ok) throw new Error(String(agent.error));
  expect(addToCrew(app, alice, repo, "b1").ok).toBe(true);
  const on = await updateRepoSettings(app, alice, repo, {
    autonomy: "autonomous",
    autonomyDirection: "Keep the notes tidy.",
    autonomyCeilingUsd: 10,
    autonomySlots: 1,
    autonomyBy: alice.id,
  });
  expect(on.ok).toBe(true);
  open(alice, "P0 Notes: keep notes");
  gate = open(alice, "Later gate: nothing behind this starts until the owner opens it");
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("a lift reaches the picker", () => {
  test("an issue with no pillar, lifted, is under a pillar and picked on the next tick", async () => {
    const issue = open(alice, "Rename a note");
    expect(linkIssue(app, alice, fresh(), issue, gate).ok).toBe(true);
    expect(readyNumbers()).not.toContain(issue.number);
    expect(servedBy(app.db, pillarsOf(app.db, fresh())).get(issue.id)).toBe("Later");

    const lifted = liftHold(app, alice, fresh(), current(issue));
    expect(lifted.ok).toBe(true);
    expect(servedBy(app.db, pillarsOf(app.db, fresh())).get(issue.id)).toBe("P0 Notes");
    expect(readyNumbers()).toContain(issue.number);
    expect(await driveRepo(app, fresh())).toBe("picked");
    expect(current(issue).assigneeId).not.toBeNull();
  });

  test("a reader's issue the lift would leave unadopted is still ready", () => {
    const issue = open(bob, "Export as text");
    expect(linkIssue(app, alice, fresh(), issue, gate).ok).toBe(true);
    expect(liftHold(app, alice, fresh(), current(issue)).ok).toBe(true);
    expect(readyNumbers()).toContain(issue.number);
  });

  test("the pacer's release does the same", () => {
    const issue = open(alice, "Pin the title");
    expect(linkIssue(app, alice, fresh(), issue, gate).ok).toBe(true);
    expect(releaseFromGate(app.db, repo.id, [issue.number], alice.id)).toEqual([issue.number]);
    expect(servedBy(app.db, pillarsOf(app.db, fresh())).get(issue.id)).toBe("P0 Notes");
    expect(readyNumbers()).toContain(issue.number);
    expect(heldNow(app, fresh()).startable.map((r) => r.issue.number)).toContain(issue.number);
  });
});

describe("no ready issue goes unexplained", () => {
  test("Next up gives a ready issue a builder will not start its one reason", () => {
    const busy = open(alice, "Sort notes by date");
    const free = open(alice, "Tag notes");
    createRun(app.db, { repoId: repo.id, kind: "agent", issueId: busy.id, actorId: alice.id, reason: "assigned" });
    const scope = { sealed: true as const };
    const rows = nextUp(app.db, fresh(), scope, (ready) => notStartable(app, fresh(), ready, scope)).rows;
    expect(rows.find((r) => r.issue.id === busy.id)!.why).toBe("a run is in flight on it");
    expect(rows.find((r) => r.issue.id === free.id)!.why).toBeNull();
  });

  test("the tick line counts what the picker passes over, and says none when it passes nothing", () => {
    expect(passedWords(new Map())).toBe("none");
    expect(passedWords(new Map([["a", "no_bet"], ["b", "no_bet"], ["c", "polish_share"]]))).toBe("polish_share=1 no_bet=2");
  });
});
