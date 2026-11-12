/**
 * Timers and schedules (#11595), under a fake clock and a fake app: the
 * instants of a Chicago 06:30 across both daylight-saving changes, a sleeping
 * app woken, retries ending in one failure, a restart inside and outside the
 * catch-up window, a preview that never fires production's job, pause and run now.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { parseCron, nextRun } from "../src/apps/cron.ts";
import { parseManifest } from "../src/apps/manifest.ts";
import { parseSchedules } from "../src/apps/schedule_spec.ts";
import { BACKOFF_MS, fireDueTimers, idempotencyKey, type Reach } from "../src/apps/timer_fire.ts";
import { createApp } from "../src/core/apps.ts";
import { migrationFiles } from "../src/core/schema.ts";
import { migrate } from "../src/kernel/migrate.ts";
import {
  armTimer, cancelTimer, dueTimers, runNow, runsOf, scheduleTimer, setPaused, syncSchedules,
} from "../src/core/timers.ts";

const at = (s: string): number => Date.parse(s);
const iso = (n: number | undefined): string => (n === undefined ? "none" : new Date(n).toISOString());
const cron = (e: string) => {
  const r = parseCron(e);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const specs = (extra: Record<string, unknown> = {}) => {
  const r = parseSchedules([{ name: "print", cron: "30 6 * * *", timezone: "America/Chicago", path: "/jobs/print", ...extra }]);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe("cron in a timezone", () => {
  const chicago = "America/Chicago";
  test("06:30 Chicago is 12:30Z in winter and 11:30Z in summer, across both changes", () => {
    const c = cron("30 6 * * *");
    // Hand calculation: CST is UTC-6, CDT is UTC-5. The 2026 changes are March 8 and November 1.
    expect(iso(nextRun(c, chicago, at("2026-03-07T12:30:00Z")))).toBe("2026-03-08T11:30:00.000Z"); // a 23-hour day
    expect(iso(nextRun(c, chicago, at("2026-03-07T00:00:00Z")))).toBe("2026-03-07T12:30:00.000Z");
    expect(iso(nextRun(c, chicago, at("2026-10-31T11:30:00Z")))).toBe("2026-11-01T12:30:00.000Z");
    expect(iso(nextRun(c, chicago, at("2026-11-01T12:30:00Z")))).toBe("2026-11-02T12:30:00.000Z");
  });
  test("a skipped local time runs once, after the gap", () => {
    // 02:30 on 2026-03-08 does not exist in Chicago (02:00 CST jumps to 03:00 CDT = 08:00Z).
    const c = cron("30 2 * * *");
    expect(iso(nextRun(c, chicago, at("2026-03-07T12:00:00Z")))).toBe("2026-03-08T08:30:00.000Z");
    expect(iso(nextRun(c, chicago, at("2026-03-08T08:30:00Z")))).toBe("2026-03-09T07:30:00.000Z");
  });
  test("a repeated local time runs once, at its first occurrence", () => {
    // 01:30 happens at 06:30Z (CDT) and again at 07:30Z (CST) on 2026-11-01.
    const c = cron("30 1 * * *");
    expect(iso(nextRun(c, chicago, at("2026-11-01T00:00:00Z")))).toBe("2026-11-01T06:30:00.000Z");
    expect(iso(nextRun(c, chicago, at("2026-11-01T06:30:00Z")))).toBe("2026-11-02T07:30:00.000Z");
  });
  test("steps, ranges, lists, and either day field when both are set", () => {
    expect(iso(nextRun(cron("*/15 9-10 * * *"), "UTC", at("2026-01-01T09:50:00Z")))).toBe("2026-01-01T10:00:00.000Z");
    // 2026-01-01 is a Thursday; "the 15th or Monday" next fires Monday the 5th.
    expect(iso(nextRun(cron("0 0 15 * 1"), "UTC", at("2026-01-01T00:00:00Z")))).toBe("2026-01-05T00:00:00.000Z");
    expect(iso(nextRun(cron("0 0 * * 7"), "UTC", at("2026-01-01T00:00:00Z")))).toBe("2026-01-04T00:00:00.000Z");
    expect(nextRun(cron("0 0 31 2 *"), "UTC", 0)).toBeUndefined();
  });
  test("a bad expression says which field", () => {
    for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "a * * * *", "*/0 * * * *", "5-1 * * * *"]) expect(parseCron(bad).ok).toBe(false);
    const r = parseCron("* 24 * * *");
    expect(!r.ok && r.error).toContain("hour");
  });
});

describe("forge.json schedules", () => {
  const manifest = (schedules: unknown) => parseManifest(JSON.stringify({ app: { run: "bun x" }, schedules }), undefined);
  test("defaults: production, 5 min, 3 retries, one hour of catch-up", () => {
    const r = manifest([{ name: "print", cron: "30 6 * * *", timezone: "America/Chicago", path: "/jobs/print" }]);
    expect(r.ok && r.value.schedules).toEqual([
      { name: "print", cron: "30 6 * * *", timezone: "America/Chicago", path: "/jobs/print", env: "production", timeoutMs: 300_000, retries: 3, catchUpMs: 3_600_000 },
    ]);
  });
  test("catchUp none is zero, and preview is said out loud", () => {
    const s = specs({ catchUp: "none", env: "preview", timeout: 60, retries: 0 })[0]!;
    expect([s.catchUpMs, s.env, s.timeoutMs, s.retries]).toEqual([0, "preview", 60_000, 0]);
  });
  test("every mistake is refused naming the field", () => {
    const bad = (over: Record<string, unknown>) => {
      const r = parseSchedules([{ name: "a", cron: "* * * * *", path: "/x", ...over }]);
      return r.ok ? "ok" : r.error;
    };
    expect(bad({ timezone: "Mars/Base" })).toContain("timezone");
    expect(bad({ path: "https://evil.example/" })).toContain("path");
    expect(bad({ path: "//evil.example" })).toContain("path");
    expect(bad({ path: "/a/../b" })).toContain("path");
    expect(bad({ name: "Bad Name" })).toContain("name");
    expect(bad({ timeout: 99_999 })).toContain("timeout");
    expect(bad({ retries: 11 })).toContain("retries");
    expect(bad({ catchUp: "forever" })).toContain("catchUp");
    expect(bad({ timezne: "UTC" })).toContain("unknown key");
    expect(bad({ env: "staging" })).toContain("env");
    expect(parseSchedules([{ name: "a", cron: "* * * * *", path: "/x" }, { name: "a", cron: "* * * * *", path: "/y" }]).ok).toBe(false);
    expect(manifest("nope").ok).toBe(false);
  });
});

/** A database with one app, and a fake app the forge can wake. */
function world() {
  const db = new Database(":memory:");
  migrate(db, migrationFiles);
  const repoId = "r1";
  const made = createApp(db, { repoId, slug: "paper", access: "private" });
  if (!made.ok) throw new Error(made.error);
  const app = made.value;
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const w = { asleep: true, wakes: 0, status: 200, hang: false, wakeFails: false };
  const reach: Reach = {
    async ensure() {
      if (w.asleep) {
        w.wakes++;
        if (w.wakeFails) return undefined;
        w.asleep = false;
      }
      return 4321;
    },
    identityKey: (id) => `key-of-${id}`,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: init.body });
      if (w.hang) throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      return new Response("printed 3 pages", { status: w.status });
    }) as unknown as typeof fetch,
  };
  let clock = at("2026-11-12T00:00:00Z");
  return { db, app, calls, w, reach, now: () => clock, set: (s: string) => void (clock = at(s)), advance: (ms: number) => void (clock += ms) };
}

describe("firing", () => {
  test("a schedule fires at its instant, wakes a sleeping app, and sends one signed request", async () => {
    const x = world();
    syncSchedules(x.db, x.app.id, "production", specs(), "c1", x.now());
    const t = scheduleTimer(x.db, x.app.id, "print", "production")!;
    expect(iso(t.dueAt)).toBe("2026-11-12T12:30:00.000Z");
    x.set("2026-11-12T12:29:59Z");
    expect(await fireDueTimers(x.db, x.reach, x.now)).toBe(0);
    x.set("2026-11-12T12:30:00Z");
    expect(await fireDueTimers(x.db, x.reach, x.now)).toBe(1);
    expect(x.w.wakes).toBe(1);
    expect(x.calls).toHaveLength(1);
    const h = x.calls[0]!.headers;
    expect(x.calls[0]!.url).toBe("http://127.0.0.1:4321/jobs/print");
    expect(h["x-forge-schedule"]).toBe("print");
    expect(h["x-forge-scheduled-at"]).toBe("2026-11-12T12:30:00.000Z");
    expect(h["x-forge-attempt"]).toBe("1");
    expect(h["idempotency-key"]).toBe("paper:print:2026-11-12T12:30:00.000Z");
    // The signature is the app's identity-key HMAC over the identity the headers name.
    expect(h["x-forge-signature"]).toBe(createHmac("sha256", `key-of-${x.app.id}`).update(h["x-forge-identity"]!).digest("base64url"));
    const [run] = runsOf(x.db, x.app.id);
    expect([run!.status, run!.httpStatus, run!.attempts, run!.response, run!.lateMs]).toEqual(["ok", 200, 1, "printed 3 pages", 0]);
    // Re-armed for tomorrow (CST now: 12:30Z).
    expect(iso(scheduleTimer(x.db, x.app.id, "print", "production")!.dueAt)).toBe("2026-11-13T12:30:00.000Z");
  });

  test("a failing app is retried with backoff, then the run fails once", async () => {
    const x = world();
    syncSchedules(x.db, x.app.id, "production", specs({ retries: 2 }), "c1", x.now());
    x.set("2026-11-12T12:30:00Z");
    x.w.status = 500;
    await fireDueTimers(x.db, x.reach, x.now);
    expect(runsOf(x.db, x.app.id)).toHaveLength(0);
    expect(iso(scheduleTimer(x.db, x.app.id, "print", "production")!.dueAt)).toBe(iso(at("2026-11-12T12:30:00Z") + BACKOFF_MS[0]!));
    x.advance(BACKOFF_MS[0]!);
    await fireDueTimers(x.db, x.reach, x.now);
    x.advance(BACKOFF_MS[1]!);
    await fireDueTimers(x.db, x.reach, x.now);
    expect(x.calls.map((c) => c.headers["x-forge-attempt"])).toEqual(["1", "2", "3"]);
    // The key is the same on every attempt: it names the occurrence, not the try.
    expect(new Set(x.calls.map((c) => c.headers["idempotency-key"])).size).toBe(1);
    const runs = runsOf(x.db, x.app.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.error).toBe("the app answered 500, after 3 attempts");
    expect(runs[0]!.attempts).toBe(3);
    expect(iso(scheduleTimer(x.db, x.app.id, "print", "production")!.dueAt)).toBe("2026-11-13T12:30:00.000Z");
  });

  test("an app that will not wake, and one that does not answer in time, fail in plain words", async () => {
    const x = world();
    syncSchedules(x.db, x.app.id, "production", specs({ retries: 0 }), "c1", x.now());
    x.set("2026-11-12T12:30:00Z");
    x.w.wakeFails = true;
    await fireDueTimers(x.db, x.reach, x.now);
    expect(runsOf(x.db, x.app.id)[0]!.error).toBe("the app would not wake, after 1 attempt");
    x.w.wakeFails = false;
    x.w.hang = true;
    x.set("2026-11-13T12:30:00Z");
    await fireDueTimers(x.db, x.reach, x.now);
    expect(runsOf(x.db, x.app.id)[0]!.error).toBe("no answer within 300 s, after 1 attempt");
  });

  test("a timer due during a restart fires after boot inside catchUp and is marked late", async () => {
    const x = world();
    syncSchedules(x.db, x.app.id, "production", specs(), "c1", x.now());
    // The forge is away from 12:00 to 12:50; the timer was due at 12:30. Timers are rows, so a new loop finds it.
    x.set("2026-11-12T12:50:00Z");
    expect(dueTimers(x.db, x.now())).toHaveLength(1);
    await fireDueTimers(x.db, x.reach, x.now);
    const run = runsOf(x.db, x.app.id)[0]!;
    expect(run.status).toBe("ok");
    expect(run.lateMs).toBe(20 * 60_000);
    expect(run.lateReason).toContain("down or restarting");
    // It keeps the scheduled time in its key, so the app sees the same occurrence.
    expect(x.calls[0]!.headers["idempotency-key"]).toBe("paper:print:2026-11-12T12:30:00.000Z");
  });

  test("past catchUp the run is skipped and recorded as missed; 'none' skips any lateness", async () => {
    const x = world();
    syncSchedules(x.db, x.app.id, "production", specs(), "c1", x.now());
    x.set("2026-11-12T15:00:00Z");
    await fireDueTimers(x.db, x.reach, x.now);
    expect(x.calls).toHaveLength(0);
    const run = runsOf(x.db, x.app.id)[0]!;
    expect(run.status).toBe("missed");
    expect(run.error).toContain("60 min catch-up window");
    expect(iso(scheduleTimer(x.db, x.app.id, "print", "production")!.dueAt)).toBe("2026-11-13T12:30:00.000Z");

    const y = world();
    syncSchedules(y.db, y.app.id, "production", specs({ catchUp: "none" }), "c1", y.now());
    y.set("2026-11-12T12:31:30Z");
    await fireDueTimers(y.db, y.reach, y.now);
    expect(y.calls).toHaveLength(0);
    expect(runsOf(y.db, y.app.id)[0]!.error).toContain("catch-up is none");
  });

  test("a preview never fires production's schedule; one that says env preview fires in previews only", () => {
    const x = world();
    syncSchedules(x.db, x.app.id, "pull-3", specs(), "c1", x.now());
    expect(scheduleTimer(x.db, x.app.id, "print", "pull-3")).toBeUndefined();
    expect(dueTimers(x.db, at("2030-01-01T00:00:00Z"))).toHaveLength(0);
    syncSchedules(x.db, x.app.id, "production", specs({ env: "preview" }), "c1", x.now());
    expect(scheduleTimer(x.db, x.app.id, "print", "production")).toBeUndefined();
    syncSchedules(x.db, x.app.id, "pull-3", specs({ env: "preview" }), "c1", x.now());
    expect(scheduleTimer(x.db, x.app.id, "print", "pull-3")).toBeDefined();
  });

  test("pause holds a schedule, resume waits for the next occurrence, run now fires once without moving it", async () => {
    const x = world();
    syncSchedules(x.db, x.app.id, "production", specs(), "c1", x.now());
    const t = scheduleTimer(x.db, x.app.id, "print", "production")!;
    setPaused(x.db, t.id, true, x.now());
    x.set("2026-11-12T12:35:00Z");
    expect(await fireDueTimers(x.db, x.reach, x.now)).toBe(0);
    // Run now works on a paused schedule too, and the clock's own occurrence stays where it was.
    expect(runNow(x.db, x.app.id, "print", "production", x.now())).toBe(true);
    expect(await fireDueTimers(x.db, x.reach, x.now)).toBe(1);
    expect(x.calls[0]!.headers["idempotency-key"]).toBe("paper:print:2026-11-12T12:35:00.000Z");
    expect(runsOf(x.db, x.app.id, "print")[0]!.status).toBe("ok");
    expect(scheduleTimer(x.db, x.app.id, "print", "production")!.paused).toBe(true);
    setPaused(x.db, t.id, false, x.now());
    expect(iso(scheduleTimer(x.db, x.app.id, "print", "production")!.dueAt)).toBe("2026-11-13T12:30:00.000Z");
    expect(runNow(x.db, x.app.id, "nope", "production", x.now())).toBe(false);
  });

  test("an app's one-shot fires with its body and key, once, and can be cancelled", async () => {
    const x = world();
    const body = new TextEncoder().encode('{"n":1}');
    armTimer(x.db, { appId: x.app.id, env: "production", key: "digest-9", path: "/jobs/digest", at: at("2026-11-12T01:00:00Z"), body, timeoutMs: 1000, retries: 0 }, x.now());
    armTimer(x.db, { appId: x.app.id, env: "production", key: "gone", path: "/jobs/x", at: at("2026-11-12T01:00:00Z"), timeoutMs: 1000, retries: 0 }, x.now());
    expect(cancelTimer(x.db, x.app.id, "production", "gone")).toBe(true);
    expect(cancelTimer(x.db, x.app.id, "production", "gone")).toBe(false);
    x.set("2026-11-12T01:00:00Z");
    await fireDueTimers(x.db, x.reach, x.now);
    await fireDueTimers(x.db, x.reach, x.now);
    expect(x.calls).toHaveLength(1);
    expect(x.calls[0]!.headers["idempotency-key"]).toBe("paper:digest-9");
    expect(x.calls[0]!.body).toEqual(body);
  });

  test("five days of failure pause a schedule and say so", async () => {
    const x = world();
    syncSchedules(x.db, x.app.id, "production", specs({ retries: 0 }), "c1", x.now());
    x.w.status = 503;
    for (let d = 12; d <= 16; d++) {
      x.set(`2026-11-${d}T12:30:00Z`);
      await fireDueTimers(x.db, x.reach, x.now);
    }
    const t = scheduleTimer(x.db, x.app.id, "print", "production")!;
    expect(t.paused).toBe(true);
    const latest = runsOf(x.db, x.app.id, "print")[0]!;
    expect(latest.status).toBe("paused");
    expect(latest.error).toContain("failed 5 days running");
  });

  test("the idempotency key is app, name, scheduled time", () => {
    expect(idempotencyKey("paper", { name: "print", key: "print", scheduledAt: at("2026-11-12T12:30:00Z"), kind: "schedule" })).toBe("paper:print:2026-11-12T12:30:00.000Z");
  });
});

describe("the reads walk an index", () => {
  test("no scan and no sort for due timers, an app's schedules, its runs, and its latest run of each", () => {
    const { db } = world();
    const sqls = [
      "SELECT * FROM timer WHERE paused = 0 AND due_at <= ?1 ORDER BY due_at, id LIMIT ?2",
      "SELECT * FROM timer WHERE app_id = ?1 AND kind = 'schedule' ORDER BY name, env",
      "SELECT * FROM timer_run WHERE app_id = ?1 ORDER BY id DESC LIMIT ?2",
      "SELECT * FROM timer_run WHERE app_id = ?1 AND name = ?2 AND env = ?3 ORDER BY id DESC LIMIT 1",
    ];
    for (const sql of sqls) {
      const n = Math.max(...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
      for (const row of db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...Array.from({ length: n }, () => "x")) as { detail: string }[]) {
        expect(row.detail).not.toMatch(/^SCAN (?!.*USING (COVERING )?INDEX)/);
      }
    }
  });
});
