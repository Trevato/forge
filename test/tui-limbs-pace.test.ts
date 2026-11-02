/**
 * The limbs screen draws each milestone's pace under its row (#8058): a
 * sparkline of issues closed per day and `pace.line` word for word, the
 * same line the milestones page draws from the same `readPlan`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { readPlan } from "../src/core/milestones.ts";
import { PACE_DAYS } from "../src/core/pace.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { paceSpark, paceText } from "../src/tui/screens/limbs.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const SPARK = /[▁▂▃▄▅▆▇█]{14}/;

describe("pace under each milestone in the terminal", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  let manyId = "";
  let moving: Issue;
  let still: Issue;
  const plan = (): ReturnType<typeof readPlan> => readPlan(app.db, getRepoById(app.db, manyId)!, { spend: false });
  const fresh = () => getRepoById(app.db, repo.id)!;
  const current = (i: Issue) => getIssueById(app.db, i.id)!;
  const open = (title: string): Issue => {
    const made = openIssue(app, alice, fresh(), { title });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };

  function boot(rows = 32, cols = 120, name = "alice/pace") {
    const terminal = headlessTerminal(cols, rows);
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user: alice };
    const { app: tui } = createForgeApp(app, identity, { terminal, exitHooks: false });
    tui.start();
    const press = async (...keys: string[]) => {
      for (const key of keys) tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(tui);
    };
    const toLimbs = async () => {
      await settleApp(tui);
      tui.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
      await settleApp(tui);
      await press(..."Milestones in a repository".split(""), "enter");
      await press(...name.split(""), "enter");
    };
    const mouse = async (kind: "press" | "wheel-down" | "wheel-up", x: number, y: number) => {
      tui.dispatch({ type: "mouse", kind, button: 0, x, y, ctrl: false, alt: false, shift: false });
      await settleApp(tui);
    };
    const text = () => tui.screen.toText();
    /** The screen row holding `needle`. */
    const rowOf = (needle: string): number => text().split("\n").findIndex((r) => /\d+\. #\d+ /.test(r) && r.includes(needle));
    /** Click the row that holds `needle`, `below` rows under it. */
    const click = (needle: string, below = 0) => mouse("press", 12, rowOf(needle) + below);
    return { text, press, toLimbs, click, mouse, rowOf, stop: () => tui.stop() };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-pace-"));
    app = createApp({ dataDir, port: 0 });
    const user = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!user.ok) throw new Error(String(user.error));
    alice = getUserByName(app.db, "alice")!;
    const made = await createRepo(app, alice, { name: "pace", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    moving = open("Moving");
    still = open("Still");
    const leaves = [1, 2, 3, 4, 5].map((n) => open(`Moving leaf ${n}`));
    for (const leaf of leaves) linkIssue(app, alice, fresh(), current(moving), current(leaf));
    linkIssue(app, alice, fresh(), current(still), current(open("Still leaf")));
    // Three closed on three different days, two left open.
    for (const [leaf, daysAgo] of [[leaves[0]!, 1], [leaves[1]!, 3], [leaves[2]!, 5]] as const) {
      expect(setIssueState(app, alice, fresh(), current(leaf), "closed").ok).toBe(true);
      const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
      app.db.query("UPDATE issue SET closed_at = ?1 WHERE id = ?2").run(at, leaf.id);
    }
  });

  /** A repository of `n` milestones, each with a pace line, behind one that says none. */
  async function manyMilestones(): Promise<void> {
    const made = await createRepo(app, alice, { name: "many", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const many = made.value;
    const mk = (title: string): Issue => {
      const o = openIssue(app, alice, many, { title });
      if (!o.ok) throw new Error(String(o.error));
      return o.value;
    };
    const fresh2 = () => getRepoById(app.db, many.id)!;
    const cur = (i: Issue) => getIssueById(app.db, i.id)!;
    // Quiet: finished, but with no recorded day, so the page has no line to say.
    const quiet = mk("Quiet");
    const quietLeaf = mk("Quiet leaf");
    linkIssue(app, alice, fresh2(), cur(quiet), cur(quietLeaf));
    expect(setIssueState(app, alice, fresh2(), cur(quietLeaf), "closed").ok).toBe(true);
    app.db.query("UPDATE issue SET closed_at = NULL WHERE id = ?1").run(quietLeaf.id);
    for (let n = 1; n <= 8; n++) {
      const m = mk(`Mile ${n}`);
      const done = mk(`Mile ${n} done`);
      linkIssue(app, alice, fresh2(), cur(m), cur(done));
      const open = mk(`Mile ${n} open`);
      linkIssue(app, alice, fresh2(), cur(m), cur(open));
      // Mile 2 has a limb of its own, so `enter` has something to open.
      if (n === 2) linkIssue(app, alice, fresh2(), cur(open), cur(mk("Mile 2 deep")));
      expect(setIssueState(app, alice, fresh2(), cur(done), "closed").ok).toBe(true);
    }
    manyId = many.id;
  }

  beforeAll(manyMilestones);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a milestone that closed issues on three days shows the page's sentence and a sparkline of PACE_DAYS cells", async () => {
    const m = readPlan(app.db, fresh(), { spend: false }).milestone(moving.number)!;
    expect(m.pace.closedPerDay.filter((n) => n > 0)).toHaveLength(3);
    expect(m.pace.line).toContain("on pace for");
    const spark = paceSpark(m.pace.closedPerDay);
    expect([...spark]).toHaveLength(PACE_DAYS);

    const h = boot();
    await h.toLimbs();
    expect(h.text()).toContain(`${spark} ${m.pace.line}`);
    h.stop();
  });

  test("a milestone with no pace line draws no pace row and stays one row tall", async () => {
    const quiet = plan().limbs.find((l) => l.name === "Quiet");
    expect(quiet).toBeDefined();
    const m = plan().milestone(quiet!.issue.number)!;
    expect(m.pace.line).toBe("");
    const h = boot(32, 120, "alice/many");
    await h.toLimbs();
    const y = h.rowOf("Quiet");
    expect(y).toBeGreaterThan(0);
    // The row under it is the next milestone, not a pace row.
    const lines = h.text().split("\n");
    expect(lines[y + 1]).toContain("Mile 1");
    expect(lines[y]).not.toMatch(SPARK);
    expect(lines[y + 1]).not.toMatch(SPARK);
    h.stop();
  });

  test("the sparkline of a quiet fortnight is the lowest block; no line is no text", () => {
    const m = readPlan(app.db, fresh(), { spend: false }).milestone(still.number)!;
    expect(m.pace.closedPerDay.every((n) => n === 0)).toBe(true);
    expect(paceSpark(m.pace.closedPerDay)).toBe("▁".repeat(PACE_DAYS));
    expect(paceText({ ...m.pace, line: "" }, 80)).toBe("");
  });

  test("a narrow terminal drops the sparkline before the sentence, by the width the list has", async () => {
    const m = readPlan(app.db, fresh(), { spend: false }).milestone(moving.number)!;
    const both = PACE_DAYS + 1 + m.pace.line.length;
    expect(paceText(m.pace, both)).toMatch(SPARK);
    expect(paceText(m.pace, both - 1)).toBe(m.pace.line);
    // 40 columns less the scrollbar and the 4-cell indent is 35 cells for the note.
    expect(35).toBeLessThan(both);
    expect(35).toBeGreaterThanOrEqual(m.pace.line.length);
    const h = boot(32, 40);
    await h.toLimbs();
    expect(h.text()).toContain(m.pace.line);
    expect(h.text()).not.toMatch(SPARK);
    h.stop();
    // The terminal refuses anything under 40x10, so narrower than the sentence is the helper's.
    const cut = paceText(m.pace, 10);
    expect([...cut].length).toBeLessThanOrEqual(10);
    expect(cut).toContain("on pace");
  });

  test("a width of nothing or less draws nothing, and the smallest terminal the app accepts does not throw", async () => {
    const m = readPlan(app.db, fresh(), { spend: false }).milestone(moving.number)!;
    for (const w of [0, -1, -40]) expect(paceText(m.pace, w)).toBe("");
    for (const [rows, cols] of [[10, 40], [3, 4]] as const) {
      const h = boot(rows, cols);
      await h.toLimbs();
      expect(typeof h.text()).toBe("string");
      h.stop();
    }
  });

  test("a short terminal scrolls by milestone: the cursor's row and its pace line are both on screen", async () => {
    const h = boot(10, 120, "alice/many");
    await h.toLimbs();
    for (let n = 1; n <= 8; n++) {
      await h.press("j");
      const lines = h.text().split("\n");
      const y = lines.findIndex((r) => new RegExp(`\\d+\\. #\\d+ Mile ${n}\\b`).test(r));
      expect(y).toBeGreaterThanOrEqual(0);
      expect(lines[y + 1]).toContain("on pace for");
    }
    h.stop();
  });

  test("a click on a pace row selects its milestone; a second click opens it", async () => {
    const h = boot(32, 120, "alice/many");
    await h.toLimbs();
    // Milestones with leaves of their own open on enter; the cursor moves first.
    await h.click("Mile 3", 1);
    await h.press("r");
    expect(h.text()).toContain("Raise “Mile 3”?");
    h.stop();
  });

  test("a double click on a pace row opens that milestone", async () => {
    const h = boot(32, 120, "alice/many");
    await h.toLimbs();
    expect(h.text()).not.toContain("Mile 2 open");
    await h.click("Mile 2", 1);
    await h.click("Mile 2", 1);
    expect(h.text()).toContain("Mile 2 open");
    h.stop();
  });

  test("the wheel moves the cursor and keeps its pace line on screen", async () => {
    const h = boot(10, 120, "alice/many");
    await h.toLimbs();
    await h.mouse("wheel-down", 12, 4);
    await h.mouse("wheel-down", 12, 4);
    const lines = h.text().split("\n");
    // Two notches of three rows put the cursor on the seventh limb: Mile 6.
    const y = lines.findIndex((r) => /\d+\. #\d+ Mile 6\b/.test(r));
    expect(y).toBeGreaterThanOrEqual(0);
    expect(lines[y + 1]).toContain("on pace for");
    h.stop();
  });

  test("raise and lower still address the row under the cursor", async () => {
    const h = boot();
    await h.toLimbs();
    await h.press("j");
    await h.press("r");
    expect(h.text()).toContain("Raise");
    h.stop();
  });
});
