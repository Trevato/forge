/**
 * The terminal's issue screen shows what an issue waits for and holds up,
 * each number opening that issue, and `w` adds or removes a wait through
 * the same `linkIssue` and `unlinkIssue` the page and MCP `wait_for` use.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dependencyWords, linkIssue } from "../src/actions/dependencies.ts";
import { THREAD_SAYS } from "../src/actions/thread_words.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { addDependency, dependenciesOf } from "../src/core/dependencies.ts";
import type { Issue } from "../src/core/issues.ts";
import { addTeamMember, createOrg, createTeam, removeTeamMember } from "../src/core/orgs.ts";
import { createRepo as createCoreRepo, getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { issueScreen } from "../src/tui/screens/issue.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("the terminal's issue screen and its waits", () => {
  let dataDir = "";
  let app: App;
  let alice: User;
  let bob: User;
  let repo: Repo;
  const fresh = () => getRepoById(app.db, repo.id)!;
  const newIssue = (title: string): Issue => {
    const o = openIssue(app, alice, repo, { title });
    if (!o.ok) throw new Error(o.error);
    return o.value;
  };
  const waitsFor = (issue: Issue) =>
    dependenciesOf(app.db, issue.id).blockedBy.map((i) => i.number);

  /** A terminal signed in as `user`, on the issue screen of `number`. */
  const open = async (user: User, number: number, where: Repo = fresh(), rows = 40) => {
    const terminal = headlessTerminal(140, rows);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user },
      { terminal, exitHooks: false },
    );
    tui.start();
    await settleApp(tui);
    tui.push(issueScreen(session, tui.ctx, local(session, where), number));
    await settleApp(tui);
    const press = async (...keys: string[]) => {
      for (const key of keys)
        tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(tui);
    };
    const type = (text: string) => press(...text);
    const text = () => tui.screen.toText();
    /** Click the first cell of `needle` on the row that also holds `row`. */
    const click = async (row: string, needle: string) => {
      const rows = text().split("\n");
      const y = rows.findIndex((r) => r.includes(row) && r.includes(needle));
      if (y < 0) throw new Error(`no row with ${row} and ${needle}:\n${text()}`);
      const x = rows[y]!.indexOf(needle, rows[y]!.indexOf(row));
      tui.dispatch({ type: "mouse", kind: "press", button: 0, x, y, ctrl: false, alt: false, shift: false });
      tui.dispatch({ type: "mouse", kind: "release", button: 0, x, y, ctrl: false, alt: false, shift: false });
      await settleApp(tui);
    };
    return { tui, press, type, text, click, stop: () => tui.stop() };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-issue-waits-"));
    app = createApp({ dataDir, port: 0 });
    for (const username of ["alice", "bob"]) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: username === "alice",
      });
      if (!made.ok) throw new Error(made.error);
      if (username === "alice") alice = made.value;
      else bob = made.value;
    }
    const r = await createRepo(app, alice, { name: "garden", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("w links a new number, the line shows it, and the number opens that issue", async () => {
    const blocker = newIssue("Lay the soil");
    const issue = newIssue("Plant the beds");
    const t = await open(alice, issue.number);
    try {
      expect(t.text()).not.toContain("Waits for #");
      await t.press("w");
      expect(t.text()).toContain(`#${issue.number} waits for issue`);
      await t.type(String(blocker.number));
      await t.press("enter");
      expect(waitsFor(issue)).toEqual([blocker.number]);
      expect(t.text()).toContain(`Waits for #${blocker.number}`);
      await t.click("Waits for", `#${blocker.number}`);
      expect(t.text()).toContain("Lay the soil");
      // The blocker's own screen says what it holds up.
      expect(t.text()).toContain(`Holds up #${issue.number}`);
    } finally {
      t.stop();
    }
  });

  test("w on a number it already waits for asks, then unlinks", async () => {
    const blocker = newIssue("Buy seeds");
    const issue = newIssue("Sow");
    const t = await open(alice, issue.number);
    try {
      await t.press("w");
      await t.type(`#${blocker.number}`);
      await t.press("enter");
      expect(waitsFor(issue)).toEqual([blocker.number]);
      await t.press("w");
      await t.type(String(blocker.number));
      await t.press("enter");
      expect(t.text()).toContain(`Stop waiting for #${blocker.number}?`);
      // Cancel keeps the wait.
      await t.press("esc");
      expect(waitsFor(issue)).toEqual([blocker.number]);
      await t.press("w");
      await t.type(String(blocker.number));
      await t.press("enter");
      await t.press("enter");
      expect(waitsFor(issue)).toEqual([]);
      expect(t.text()).not.toContain(`Waits for #${blocker.number}`);
    } finally {
      t.stop();
    }
  });

  test("a pull number and a loop are refused in dependencyWords' words", async () => {
    const c = await commitToBranch(app, alice, repo, {
      branch: "fence",
      base: "main",
      message: "fence",
      files: [{ path: "fence.md", content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const pull = await openPull(app, alice, repo, {
      title: "A fence",
      body: "",
      baseBranch: "main",
      headBranch: "fence",
    });
    if (!pull.ok) throw new Error(String(pull.error));
    const first = newIssue("Water");
    const issue = newIssue("Harvest");
    const t = await open(alice, issue.number);
    try {
      await t.press("w");
      await t.type(String(pull.value.number));
      await t.press("enter");
      expect(t.text()).toContain(dependencyWords.not_an_issue!);
      expect(waitsFor(issue)).toEqual([]);
      await t.press("esc");
      // #first waits for this one already; this waiting for #first loops.
      const back = await open(alice, first.number);
      await back.press("w");
      await back.type(String(issue.number));
      await back.press("enter");
      back.stop();
      await t.press("w");
      await t.type(String(first.number));
      await t.press("enter");
      expect(t.text()).toContain(dependencyWords.cycle!);
      expect(waitsFor(issue)).toEqual([]);
    } finally {
      t.stop();
    }
  });

  test("a reader sees the line but has no w", async () => {
    const blocker = newIssue("Dig");
    const issue = newIssue("Fill");
    const t = await open(alice, issue.number);
    await t.press("w");
    await t.type(String(blocker.number));
    await t.press("enter");
    t.stop();
    const r = await open(bob, issue.number);
    try {
      expect(r.text()).toContain(`Waits for #${blocker.number}`);
      expect(r.text()).not.toContain("waits for issue");
      await r.press("w");
      expect(r.text()).not.toContain(`#${issue.number} waits for issue`);
      expect(waitsFor(issue)).toEqual([blocker.number]);
    } finally {
      r.stop();
    }
  });

  test("a refused link reads the planner words: write taken away while the screen is open", async () => {
    const org = createOrg(app.db, "acme", alice.id);
    if (!org.ok) throw new Error(org.error);
    const writers = createTeam(app.db, org.value.id, "Writers", "write");
    if (!writers.ok) throw new Error(writers.error);
    addTeamMember(app.db, writers.value, bob.id);
    const made = await createCoreRepo(app.db, app.reposRoot, {
      ownerId: org.value.id,
      name: "orchard",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    const orchard = made.value;
    const opened = (title: string): Issue => {
      const o = openIssue(app, alice, orchard, { title });
      if (!o.ok) throw new Error(o.error);
      return o.value;
    };
    const blocker = opened("Graft");
    const issue = opened("Prune");
    const r = await open(bob, issue.number, orchard);
    try {
      // Bob could write when the screen opened, so `w` is there; by the
      // time he uses it he is off the team, and `linkIssue` says so.
      removeTeamMember(app.db, writers.value, bob.id);
      await r.press("w");
      await r.type(String(blocker.number));
      await r.press("enter");
      // Said in full, and the prompt closed: no other number would do.
      expect(r.text()).toContain(THREAD_SAYS.planForbidden);
      expect(r.text()).not.toContain(`#${issue.number} waits for issue`);
      expect(waitsFor(issue)).toEqual([]);
    } finally {
      r.stop();
    }
  });

  test("w unlinks a wait written since the screen last loaded", async () => {
    const blocker = newIssue("Mulch");
    const issue = newIssue("Weed");
    const t = await open(alice, issue.number);
    try {
      // Written under the screen with no event, so nothing reloads it.
      expect(addDependency(app.db, issue, blocker, alice.id).ok).toBe(true);
      await t.press("w");
      await t.type(String(blocker.number));
      await t.press("enter");
      expect(t.text()).toContain(`Stop waiting for #${blocker.number}?`);
      await t.press("enter");
      expect(waitsFor(issue)).toEqual([]);
    } finally {
      t.stop();
    }
  });

  test("on a 24-row terminal the waits line still leaves the conversation room", async () => {
    const blocker = newIssue("Rake");
    const issue = newIssue("Edge the lawn");
    expect(linkIssue(app, alice, fresh(), issue, blocker).ok).toBe(true);
    const t = await open(alice, issue.number, fresh(), 24);
    try {
      expect(t.text()).toContain(`Waits for #${blocker.number}`);
      expect(t.text()).toContain("No description.");
    } finally {
      t.stop();
    }
  });
});
