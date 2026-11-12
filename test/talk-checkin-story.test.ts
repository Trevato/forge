/**
 * The check-in's story (#11464): the releases cut and the pillars that merged
 * work since the last check-in, gathered from a real forge. The window is the
 * routine's own `lastAt`, so a second run does not repeat the first.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { listTurns } from "../src/core/conversations.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { runRoutine } from "../src/crew/routines.ts";
import { storyFacts } from "../src/crew/routine_facts_story.ts";
import { listRoutines } from "../src/core/talk_routines.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let repo: Repo;
const fresh = () => getRepoById(app.db, repo.id)!;
const T = Date.now();
const H = 3_600_000;

const issue = (title: string) => {
  const o = openIssue(app, alice, fresh(), { title });
  if (!o.ok) throw new Error(String(o.error));
  return o.value;
};
const land = async (name: string, closes: number) => {
  const b = await commitToBranch(app, alice, fresh(), { branch: `f/${name}`, base: "main", message: name, files: [{ path: `${name}.md`, content: name }] });
  if (!b.ok) throw new Error(JSON.stringify(b.error));
  const p = await openPull(app, alice, fresh(), { title: `Land ${name}`, body: `Closes #${closes}`, baseBranch: "main", headBranch: `f/${name}` });
  if (!p.ok) throw new Error(String(p.error));
  const m = await mergePull(app, alice, fresh(), p.value, "squash");
  if (!m.ok) throw new Error(JSON.stringify(m.error));
  return p.value.id;
};
const release = async (version: string) => {
  const r = await commitToBranch(app, alice, fresh(), { message: `Release ${version}: Something (#1)`, files: [{ path: `v${version}.txt`, content: version }] });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-story-"));
  app = createApp({ dataDir: dir, port: 0, forgeRepo: "alice/engine" });
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  alice = u.value;
  const made = await createRepo(app, alice, { name: "engine", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const seed = await commitToBranch(app, alice, repo, { message: "Start", files: [{ path: "README.md", content: "# e\n" }] });
  if (!seed.ok) throw new Error(JSON.stringify(seed.error));
  const trust = issue("P0 Trust: agents contained");
  const a = issue("Sandbox");
  const b = issue("Review");
  for (const i of [a, b]) if (!linkIssue(app, alice, fresh(), trust, i).ok) throw new Error("link");
  const early = await land("early", a.number);
  const late = await land("late", b.number);
  const pin = (id: string, at: number) => app.db.query("UPDATE pull SET merged_at = ?1 WHERE issue_id = ?2").run(new Date(at).toISOString(), id);
  pin(early, T - 5 * H);
  pin(late, T - 60_000);
  await release("0.1.1");
  await release("0.1.2");
}, 60_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("storyFacts", () => {
  test("counts pulls merged inside the window by pillar, and not the one before it", async () => {
    const s = await storyFacts(app, T - H);
    expect(s.pillarsMoved).toEqual([{ pillar: "P0 Trust", merged: 1 }]);
    expect((await storyFacts(app, T - 6 * H)).pillarsMoved).toEqual([{ pillar: "P0 Trust", merged: 2 }]);
    expect((await storyFacts(app, T + H)).pillarsMoved).toEqual([]);
  });
  test("names the releases cut after the window opened, oldest first", async () => {
    expect((await storyFacts(app, T - H)).releases).toEqual(["0.1.1", "0.1.2"]);
    expect((await storyFacts(app, T + H)).releases).toEqual([]);
  });
});

describe("runRoutine's window is the last check-in", () => {
  test("the second run does not repeat the first's releases and pillars", async () => {
    const first = new Date(T + 60_000);
    const one = await runRoutine(app, alice, "checkin", first, async () => true);
    const turnsOf = (id: string) => {
      const t = listTurns(app.db, alice.id, id);
      if (!t.ok) throw new Error(t.error);
      return t.value;
    };
    const text = (id: string) => turnsOf(id).map((t) => t.text).join("\n");
    expect(text(one.conversationId)).toContain("released 0.1.1, 0.1.2; moved: P0 Trust 1");
    expect(listRoutines(app.db, alice.id).find((r) => r.kind === "checkin")!.lastAt).toBe(first.toISOString());
    const two = await runRoutine(app, alice, "checkin", new Date(T + 120_000), async () => true);
    const turns = turnsOf(two.conversationId);
    const last = turns[turns.length - 1]!.text;
    expect(last).toContain("Forge check-in");
    expect(last).not.toMatch(/released|moved/);
  });
});
