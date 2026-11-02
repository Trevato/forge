/**
 * The decider's preference is a ranking, not an exclusive pick (#7006):
 * with the favourite builder busy and another idle, the picker hands the
 * startable issue to the idle one, so the slots run more than one builder.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { listCrewRoles } from "../src/core/agents.ts";
import { getIssueById } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createRun, listActive } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { driveRepo, idleBuilders } from "../src/crew/autonomy.ts";
import type { Decider } from "../src/crew/decide.ts";

/** Prefers scout for every builder question; the first option for anything else. */
const likesScout: Decider = {
  name: "likes-scout",
  async decide(_state, questions) {
    const out: Record<string, unknown> = {};
    for (const [key, q] of Object.entries(questions)) {
      const choice = key === "builder" && q.options.includes("scout") ? "scout" : q.options[0]!;
      const probabilities = Object.fromEntries(q.options.map((o) => [o, o === choice ? 0.9 : 0.1 / (q.options.length - 1 || 1)]));
      out[key] = { choice, p: probabilities[choice], probabilities };
    }
    return out as never;
  },
};

let dataDir: string;
let app: App;
let alice: User;
let repo: Repo;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-ranked-pick-"));
  app = createApp({ dataDir, port: 0, decider: likesScout });
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
    files: [{ path: "README.md", content: "# notes\n" }],
  });
  if (!first.ok) throw new Error(JSON.stringify(first.error));
  for (const name of ["mason", "scout"]) {
    const agent = await createAgent(app, alice, { username: name });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, repo, name).ok).toBe(true);
  }
  const on = await updateRepoSettings(app, alice, repo, {
    autonomy: "autonomous",
    autonomyDirection: "Keep the notes tidy.",
    autonomyCeilingUsd: 10,
    autonomySlots: 3,
    autonomyBy: alice.id,
  });
  expect(on.ok).toBe(true);
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("with scout busy and mason idle, the startable issue goes to mason", async () => {
  const scout = getUserByName(app.db, "scout")!;
  createRun(app.db, { repoId: repo.id, kind: "agent", actorId: scout.id, reason: "assigned" });
  const crew = listCrewRoles(app.db, repo.id);
  expect(idleBuilders(listActive(app.db, "agent"), crew)).toBe(1);
  const issue = openIssue(app, alice, getRepoById(app.db, repo.id)!, { title: "Sort the notes by date" });
  if (!issue.ok) throw new Error(String(issue.error));
  expect(await driveRepo(app, getRepoById(app.db, repo.id)!)).toBe("picked");
  expect(getIssueById(app.db, issue.value.id)!.assigneeId).toBe(getUserByName(app.db, "mason")!.id);
});
