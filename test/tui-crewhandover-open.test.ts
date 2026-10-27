/** The crew hand-overs screen opens a parked-twice issue with Enter and reads again on `r`. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createUser, getUserByName } from "../src/core/users.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import { crewHandoverScreen } from "../src/tui/screens/crewhandover.ts";
import type { Session } from "../src/tui/session.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { engine, tick, type Engine } from "./helpers/parks-engine.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let e: Engine;

function boot(username: string) {
  const user = getUserByName(e.app.db, username)!;
  const { app } = createForgeApp(
    e.app,
    { sshUsername: "t", remoteAddress: "127.0.0.1", user },
    { terminal: headlessTerminal(140, 32), exitHooks: false },
  );
  app.start();
  const key = async (k: string, ctrl = false) => {
    app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    await settleApp(app);
  };
  return { app, key, text: () => app.screen.toText() };
}

async function crewScreen(username: string) {
  const t = boot(username);
  await t.key("k", true);
  for (const ch of "Crew hand-overs") await t.key(ch);
  await t.key("enter");
  return t;
}

beforeAll(async () => {
  e = await engine("forge-handover-open-");
  const made = await createUser(e.app.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: false,
  });
  if (!made.ok) throw new Error(made.error);
});
afterAll(() => e.close());

test("Enter opens the parked issue, r reads again, a non-admin gets nothing", async () => {
  const t = await crewScreen("alice");
  expect(t.text()).toContain("Nothing handed to the planner");
  await t.key("enter");
  expect(t.app.screen.toText()).toContain("Crew hand-overs");

  const work = e.issue("Scene graph");
  expect(e.ended(work, "no changes pushed")).toBe(true);
  await tick();
  expect(e.ended(work, "nothing to propose")).toBe(true);
  await tick();
  expect(t.text()).not.toContain("Handed to the planner: ");
  await t.key("r");
  expect(t.text()).toContain("Handed to the planner: alice/engine#" + work.number);
  expect(t.text()).toMatch(/enter\s+open/);
  expect(t.text()).toMatch(/r\s+refresh/);

  await t.key("enter");
  expect(t.text()).toContain("Scene graph");
  expect(t.text()).not.toContain("Handed to the planner: ");
  t.app.stop();

  // Bob has no palette command for it; built directly, the screen has no rows to open.
  const b = await crewScreen("bob");
  expect(b.text()).not.toContain("Crew hand-overs");
  b.app.stop();
  const pushed: unknown[] = [];
  const screen = crewHandoverScreen(
    { db: e.app.db, app: e.app, user: getUserByName(e.app.db, "bob")! } as unknown as Session,
    { push: (s: unknown) => pushed.push(s) } as unknown as Ctx,
  );
  screen.key({ type: "key", key: "enter", ctrl: false, alt: false, shift: false });
  expect(pushed).toEqual([]);
});

test("Enter on the drill row opens nothing, and r clamps the cursor when the list shrinks", async () => {
  const { setIssueState } = await import("../src/actions/issues.ts");
  const { recordDrill } = await import("../src/snapshot/drills.ts");
  const keep = e.issue("Keeper");
  const gone = e.issue("Goner");
  for (const w of [keep, gone]) {
    expect(e.ended(w, "a")).toBe(true);
    await tick();
    expect(e.ended(w, "b")).toBe(true);
    await tick();
  }
  recordDrill(e.app.db, {
    at: new Date().toISOString(),
    snapshotId: "s1",
    ms: 10,
    counts: { users: 1, repositories: 1, issues: 1, pulls: 0, apps: 0 },
    health: "ok",
    verdict: "green",
    failedStep: null,
    phases: [],
    budgetMs: 0,
    reason: "x",
  });
  const t = await crewScreen("alice");
  const rows = (t.text().match(/Handed to the planner: /g) ?? []).length;
  expect(rows).toBeGreaterThanOrEqual(2);
  // Cursor to the last row, the drill: Enter stays on this screen.
  await t.key("G");
  await t.key("enter");
  expect(t.text()).toContain("Restore drill: passed");
  expect(t.text()).toContain("Handed to the planner: ");
  // Close the issue the cursor row stands past, then r: the cursor lands on a row that exists.
  setIssueState(e.app, e.alice, e.fresh(), gone, "closed");
  await t.key("r");
  expect((t.text().match(/Handed to the planner: /g) ?? []).length).toBe(rows - 1);
  await t.key("k");
  await t.key("enter");
  expect(t.text()).not.toContain("Restore drill: passed");
  t.app.stop();
});
