/** Bugs on a clock (#8709): 4 h high, 48 h otherwise; ahead of other work; counted on home. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { bugClockAlarm, bugsFirst, countBugs } from "../src/flow/bugs.ts";
import { firedAlarms } from "../src/flow/alarms.ts";
import { createRun, type Run } from "../src/core/runs.ts";
import { startOrder } from "../src/crew/dispatch.ts";
import { bugLines } from "../src/tui/screens/bugs.ts";
import type { Session } from "../src/tui/session.ts";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const ago = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();

let dir: string;
let app: App;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "bugs-"));
  app = createApp({ dataDir: dir, port: 0 });
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  app.db.run("INSERT INTO repo (id, owner_id, name) VALUES ('r', ?1, 'r')", [u.value.id]);
  for (const name of ["bug", "high"]) app.db.run("INSERT INTO label (id, repo_id, name) VALUES (?1, 'r', ?1)", [name]);
});
afterAll(async () => {
  app.close?.();
  await rm(dir, { recursive: true, force: true });
});

function issue(hoursOld: number, labels: string[], state = "open"): string {
  n++;
  const id = `i${n}`;
  app.db.run("INSERT INTO issue (id, repo_id, number, kind, title, author_id, state, created_at) VALUES (?1, 'r', ?2, 'issue', 't', (SELECT id FROM user LIMIT 1), ?3, ?4)", [id, n, state, ago(hoursOld)]);
  for (const l of labels) app.db.run("INSERT INTO issue_label (issue_id, label_id) VALUES (?1, ?2)", [id, l]);
  return id;
}

describe("bug clock", () => {
  test("nothing fires with no bug, or a bug inside its clock", () => {
    expect(bugClockAlarm(app.db, NOW).fired).toBe(false);
    issue(3, ["bug", "high"]);
    issue(47, ["bug"]);
    issue(100, []);
    issue(100, ["bug"], "closed");
    expect(bugClockAlarm(app.db, NOW).fired).toBe(false);
    expect(countBugs(app.db, NOW)).toEqual({ open: 2, overdue: 0 });
  });

  test("a high bug past 4 h raises one alarm, counted and listed with the flow alarms", () => {
    issue(5, ["bug", "high"]);
    issue(49, ["bug"]);
    const a = bugClockAlarm(app.db, NOW);
    expect(a.fired).toBe(true);
    expect(a.says).toContain("and 1 more");
    expect(countBugs(app.db, NOW)).toEqual({ open: 4, overdue: 2 });
    const fired = firedAlarms(app.db, NOW, { dataDir: null }).filter((x) => x.key === "bug_clock");
    expect(fired).toHaveLength(1);
    expect(fired[0]!.href).toMatch(/^\/alice\/r\/issues\/\d+$/);
  });

  test("dispatch starts a queued bug run before a feature run that queued first", () => {
    const feature = issue(1, []);
    const bug = issue(1, ["bug"]);
    createRun(app.db, { repoId: "r", kind: "agent", issueId: feature });
    createRun(app.db, { repoId: "r", kind: "agent", issueId: bug });
    const order = startOrder(app).order.map((r) => r.issueId);
    expect(order.indexOf(bug)).toBeLessThan(order.indexOf(feature));
  });

  test("the terminal screen counts for an admin and cuts the alarm to public for a guest", () => {
    issue(60, ["bug"]);
    const admin = { db: app.db, user: { isAdmin: true, kind: "person" } } as unknown as Session;
    const guest = { db: app.db, user: undefined } as unknown as Session;
    expect(bugLines(admin, NOW).join("\n")).toContain("Open bugs:");
    expect(bugLines(admin, NOW).join("\n")).toContain("Bug past its clock");
    expect(bugLines(guest, NOW).join("\n")).not.toContain("Open bugs:");
    app.db.run("UPDATE repo SET visibility = 'private' WHERE id = 'r'");
    expect(bugLines(guest, NOW).join("\n")).toContain("No bug is past its clock");
    expect(bugLines(admin, NOW).join("\n")).toContain("Bug past its clock");
    app.db.run("UPDATE repo SET visibility = 'public' WHERE id = 'r'");
  });

  test("bugs start ahead of other work, each side in its own order", () => {
    const feature = issue(1, []);
    const bug = issue(1, ["bug"]);
    const run = (issueId: string): Run => ({ issueId }) as unknown as Run;
    const out = bugsFirst(app.db, [run(feature), run(bug)]);
    expect(out.map((r) => r.issueId)).toEqual([bug, feature]);
  });
});

describe("home's bug figure", () => {
  test("the tile shows the open count and how many are past their clock", async () => {
    const { kpiRowFor } = await import("../src/web/studio/kpi_row.ts");
    const { NO_REACH } = await import("../src/flow/reach.ts");
    const k = { landedHours: new Array<number>(24).fill(0), landed: 0, live: null, builders: { running: 0, slots: 0, idle: null }, spend: { todayUsd: 0, ceilingUsd: null }, medianCheckMs: null, backupAt: null, reach: NO_REACH };
    expect(kpiRowFor({ ...k, bugs: { open: 4, overdue: 2 } }, null).toString()).toContain("2 past its clock");
    expect(kpiRowFor(k, null).toString()).not.toContain("Open bugs");
  });
});
