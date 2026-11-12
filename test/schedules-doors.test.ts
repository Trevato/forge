/**
 * Schedules through both doors (#11595): the app's rows read the same from the
 * page, the API and the terminal. A reader of a public app sees the schedule
 * but never what a run answered or why it failed; a writer sees it and can Run
 * and Pause from the terminal, and the write reaches the bus so web viewers
 * redraw live. A private app shows a guest nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { scheduleRows, scheduleRuns } from "../src/actions/schedules.ts";
import { parseSchedules } from "../src/apps/schedule_spec.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { recordRun, syncSchedules } from "../src/core/timers.ts";
import { createUser, type User } from "../src/core/users.ts";
import { schedulesCommands, schedulesScreen } from "../src/tui/screens/schedules.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import type { Session } from "../src/tui/session.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

let dataDir: string;
let app: App;
let cy: User; // writer
let dee: User; // reader of a public app
let pub: Repo;
let priv: Repo;

const SECRET = "digest: 3 invoices overdue";
const WHY = "the app answered 500: db password rejected";

function schedule(repo: Repo): void {
  const row = insertApp(app.db, { repoId: repo.id, slug: repo.name, access: repo.visibility });
  if (!row.ok) throw new Error(row.error);
  const specs = parseSchedules([{ name: "print", cron: "30 6 * * *", timezone: "UTC", path: "/jobs/print" }]);
  if (!specs.ok) throw new Error(specs.error);
  syncSchedules(app.db, row.value.id, "production", specs.value, "c1", Date.parse("2026-11-12T00:00:00Z"));
  const run = (id: number, status: "ok" | "failed") =>
    recordRun(app.db, { appId: row.value.id, env: "production", name: "print", idemKey: `${repo.name}:${id}`, scheduledAt: id, startedAt: id, finishedAt: id, attempts: 1, status, httpStatus: status === "ok" ? 200 : 500, response: SECRET, error: status === "ok" ? null : WHY, lateMs: 0, lateReason: null, durationMs: 5 });
  run(1, "failed");
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-sched-doors-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  const make = async (username: string, adminIfFirst = false) => {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  await make("ada", true);
  cy = await make("cy");
  promote(app.db, cy);
  dee = await make("dee");
  for (const [name, visibility] of [["pubapp", "public"], ["privapp", "private"]] as const) {
    const made = await createRepo(app, cy, { name, visibility, description: "" });
    if (!made.ok) throw new Error(String(made.error));
    schedule(made.value);
    if (name === "pubapp") pub = made.value;
    else priv = made.value;
  }
}, 60_000);

afterAll(async () => {
  app.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

const session = (user: User | undefined) => ({ user, db: app.db, app }) as unknown as Session;
const ctxWith = (toasts: string[] = []) => ({ toast: (t: string) => toasts.push(t), invalidate() {}, push() {} }) as unknown as Ctx;

describe("a run's answer and error are a writer's", () => {
  test("a reader and a guest of a public app get null, the writer gets the text", () => {
    for (const who of [dee, undefined]) {
      const row = scheduleRows(app, who, pub);
      expect(row.ok && row.value[0]!.last).toMatchObject({ status: "failed", httpStatus: 500, error: null, response: null });
      const runs = scheduleRuns(app, who, pub);
      expect(runs.ok && runs.value[0]).toMatchObject({ response: null, error: null });
    }
    const mine = scheduleRows(app, cy, pub);
    expect(mine.ok && mine.value[0]!.last).toMatchObject({ error: WHY, response: SECRET });
    const runs = scheduleRuns(app, cy, pub);
    expect(runs.ok && runs.value[0]).toMatchObject({ error: WHY, response: SECRET });
  });

  test("a guest and a stranger see nothing of a private app", () => {
    for (const who of [dee, undefined]) {
      expect(scheduleRows(app, who, priv)).toEqual({ ok: false, error: "not_found" });
      expect(scheduleRuns(app, who, priv)).toEqual({ ok: false, error: "not_found" });
      expect(schedulesCommands(session(who), ctxWith(), priv)).toEqual([]);
    }
  });
});

describe("the terminal screen", () => {
  test("a reader sees the rows and is refused writes; a guest cannot steer", () => {
    expect(schedulesCommands(session(dee), ctxWith(), pub)).toHaveLength(1);
    expect(schedulesCommands(session(cy), ctxWith(), undefined)).toEqual([]);
    for (const who of [dee, undefined]) {
      const toasts: string[] = [];
      const screen = schedulesScreen(session(who), ctxWith(toasts), pub);
      expect(screen.key?.({ key: "r" } as never)).toBe(true);
      expect(screen.key?.({ key: "p" } as never)).toBe(true);
      expect(toasts).toHaveLength(2);
      expect(toasts.join(" ")).not.toContain("running now");
    }
  });

  test("a writer can Run and Pause, and each write reaches the bus", () => {
    const toasts: string[] = [];
    const heard: string[] = [];
    const off = app.bus.subscribe((e) => heard.push(`${e.kind}:${e.repoId === pub.id}`));
    const screen = schedulesScreen(session(cy), ctxWith(toasts), pub);
    expect(screen.key?.({ key: "r" } as never)).toBe(true);
    expect(screen.key?.({ key: "p" } as never)).toBe(true);
    expect(toasts).toEqual(["print: running now.", "print: paused."]);
    const rows = scheduleRows(app, cy, pub);
    expect(rows.ok && rows.value[0]!.paused).toBe(true);
    expect(screen.key?.({ key: "p" } as never)).toBe(true);
    expect(toasts.at(-1)).toBe("print: resumed.");
    off();
    expect(heard.filter((h) => h === "schedule.steered:true")).toHaveLength(3);
  });
});
