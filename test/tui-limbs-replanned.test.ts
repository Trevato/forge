/**
 * The limbs screen says what the planner changed on a re-planned limb (#7448):
 * `Re-planned <time ago>` and one line per split, as the milestones page does,
 * and Enter on a split line opens the new issue. Owner facts only.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { replanLimb } from "../src/actions/limb_replan.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import {} from "../src/core/agents.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { ensureDirectionIssue } from "../src/crew/autonomy.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("the limbs screen after a re-plan", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let limb: Issue;
  let leaves: Issue[];
  let atlas: User;
  let fresh: () => Repo;
  const current = (i: Issue) => getIssueById(app.db, i.id)!;
  const open = (title: string, by: User): Issue => {
    const made = openIssue(app, by, fresh(), { title });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };

  function boot(user?: User, rows = 32) {
    const terminal = headlessTerminal(120, rows);
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app: tui } = createForgeApp(app, identity, { terminal, exitHooks: false });
    tui.start();
    const press = async (...keys: string[]) => {
      for (const key of keys) tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(tui);
    };
    const type = async (text: string) => press(...text.split(""));
    const toLimbs = async () => {
      await settleApp(tui);
      tui.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
      await settleApp(tui);
      await type("Milestones in a repository");
      await press("enter");
      await type("alice/engine");
      await press("enter");
    };
    return { text: () => tui.screen.toText(), press, toLimbs, stop: () => tui.stop() };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-replanned-"));
    app = createApp({ dataDir, port: 0 });
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
    }
    alice = getUserByName(app.db, "alice")!;
    bob = getUserByName(app.db, "bob")!;
    const made = await createRepo(app, alice, { name: "engine", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    fresh = () => getRepoById(app.db, repo.id)!;
    const agent = await createAgent(app, alice, { username: "atlas" });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, repo, "atlas").ok).toBe(true);
    atlas = getUserByName(app.db, "atlas")!;
    seatAs(app.db, repo.id, atlas.id, "planner");
    const set = await updateRepoSettings(app, alice, repo, {
      autonomy: "autonomous",
      autonomyDirection: "Keep the engine small.",
      autonomyCeilingUsd: 100,
      autonomyBy: alice.id,
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    limb = open("Search", alice);
    leaves = ["Index titles", "Index bodies", "Rank hits", "Highlight hits", "Cache hits", "Page hits"].map((t) => open(t, alice));
    for (const leaf of leaves) linkIssue(app, alice, fresh(), current(limb), current(leaf));
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a limb not re-planned draws no answer, and one the planner has answered does", async () => {
    const before = boot(alice);
    await before.toLimbs();
    expect(before.text()).toContain("Search");
    expect(before.text()).not.toContain("Re-planned");
    before.stop();

    const direction = ensureDirectionIssue(app, alice, fresh())!;
    expect(replanLimb(app, alice, fresh(), limb.number).ok).toBe(true);
    await Bun.sleep(5);
    const larger = open("Search over titles and bodies", atlas);
    const other = open("Search ranking", atlas);
    const close = (i: Issue, into: number[]) =>
      setIssueState(app, atlas, fresh(), current(i), "closed", { reason: "split", into });
    expect(close(leaves[0]!, [larger.number, other.number]).ok).toBe(true);
    for (const leaf of leaves.slice(1)) expect(close(leaf, [larger.number]).ok).toBe(true);
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: direction.id,
      actorId: atlas.id,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "re-planned" });

    const t = boot(alice);
    await t.toLimbs();
    expect(t.text()).toMatch(/Re-planned (just now|\d+\w ago)/);
    expect(t.text()).toContain(`#${leaves[0]!.number} Index titles → #${larger.number}, #${other.number}`);
    expect(t.text()).toContain(`#${leaves[1]!.number} Index bodies → #${larger.number}`);
    // Six splits, four drawn: the header says two are out of view.
    expect(t.text()).toContain("+2 more");
    expect(t.text()).not.toContain("Page hits →");
    // Tab onto the split lines, down to the second, Enter opens its one new issue.
    await t.press("tab", "j", "enter");
    expect(t.text()).toContain("Search over titles and bodies");
    expect(t.text()).not.toContain("Re-planned");
    await t.press("esc");
    // Enter on the line with two new issues asks which; the second opens.
    expect(t.text()).toContain("Re-planned");
    await t.press("k", "enter");
    expect(t.text()).toContain(`#${larger.number} Search over titles and bodies`);
    expect(t.text()).toContain(`#${other.number} Search ranking`);
    await t.press("j", "enter");
    expect(t.text()).toContain("Search ranking");
    await t.press("esc");
    // Scrolling down brings the hidden splits into view; tab goes back to the limbs.
    await t.press("j", "j", "j", "j", "j");
    expect(t.text()).toContain("Page hits →");
    await t.press("tab");
    expect(t.text()).not.toContain("> #");
    t.stop();
  });

  test("a short terminal keeps the list and says splits are out of view", async () => {
    const t = boot(alice, 10);
    await t.toLimbs();
    expect(t.text()).toContain("1. #");
    expect(t.text()).toContain("6 splits, too little room");
    t.stop();
  });

  test("a reader without owner facts sees none of it", async () => {
    const t = boot(bob);
    await t.toLimbs();
    expect(t.text()).toContain("Search");
    expect(t.text()).not.toContain("Re-planned");
    expect(t.text()).not.toContain("→");
    await t.press("tab");
    expect(t.text()).not.toContain("> #");
    t.stop();
  });
});
