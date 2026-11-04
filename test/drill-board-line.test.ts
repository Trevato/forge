/**
 * A red restore drill, or none in eight days, is one line on the board and
 * one push, on a deterministic clock and with no real drill.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { setNotifyUrl, startNotifier } from "../src/crew/notify.ts";
import { eventAudience } from "../src/core/event_audience.ts";
import { vitals } from "../src/kernel/vitals.ts";
import type { DrillResult } from "../src/snapshot/drill.ts";
import { DRILL_STALE_MS, recordVerdict, seedFirstSeen } from "../src/snapshot/verdict.ts";
import { forgeNeeds } from "../src/actions/health.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");

const drill = (at: number, red: boolean): DrillResult => ({
  at: new Date(at).toISOString(),
  snapshotId: "snap-1",
  ms: 5,
  counts: { repositories: 1, issues: 1, users: 0, pulls: 0, apps: 0 },
  health: red ? "failed" : "ok",
  verdict: red ? "red" : "green",
  failedStep: red ? "unseal" : null,
  phases: [],
  budgetMs: 0,
  reason: red ? "a sealed value does not open with the restored key" : null,
});

describe("the drill's board line", () => {
  let root: string;
  let app: App;
  let admin: Awaited<ReturnType<typeof createUser>> & { ok: true };
  const line = (now: number) =>
    vitals({ db: app.db, dataDir: app.config.dataDir, signals: app.signals, now }).degraded.filter(
      (d) => d.cause === "drill",
    );

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-drill-line-"));
    app = createApp({ dataDir: root, port: 0 });
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    admin = u as typeof admin;
    // The forge first looked 30 days before the test's clock.
    seedFirstSeen(root, T0 - 30 * DAY);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("none ever recorded, on a forge older than eight days: one line", () => {
    const l = line(T0);
    expect(l).toHaveLength(1);
    expect(l[0]!.sentence).toContain("No restore drill");
  });

  test("a forge younger than eight days has missed nothing", async () => {
    expect(line(T0 - 30 * DAY + DAY)).toHaveLength(0);
    const fresh = mkdtempSync(join(tmpdir(), "forge-drill-fresh-"));
    const input = { db: app.db, dataDir: fresh, signals: app.signals };
    const flagged = (now: number) =>
      vitals({ ...input, now }).degraded.some((d) => d.cause === "drill");
    // Never seeded: a pure read flags nothing and writes nothing.
    expect(flagged(T0 + 99 * DAY)).toBe(false);
    expect(() => readFileSync(join(fresh, "drill", "first-seen"))).toThrow();
    seedFirstSeen(fresh, T0);
    seedFirstSeen(fresh, T0 + 5 * DAY);
    expect(flagged(T0)).toBe(false);
    expect(flagged(T0 + 9 * DAY)).toBe(true);
    await rm(fresh, { recursive: true, force: true });
  });

  test("red: one line naming the step", () => {
    recordVerdict(root, drill(T0, true));
    const l = line(T0 + 1000);
    expect(l).toHaveLength(1);
    expect(l[0]!.sentence).toContain("failed at unseal");
    expect(forgeNeeds(app, admin.value)!.filter((n) => n.includes("unseal"))).toHaveLength(1);
  });

  test("green clears it, and eight days later it is back", () => {
    recordVerdict(root, drill(T0 + DAY, false));
    expect(line(T0 + 2 * DAY)).toHaveLength(0);
    expect(line(T0 + DAY + DRILL_STALE_MS - 1)).toHaveLength(0);
    const l = line(T0 + DAY + DRILL_STALE_MS + 1);
    expect(l).toHaveLength(1);
    expect(l[0]!.sentence).toContain("last one passed on 2026-10-02");
  });

  test("one push per cause, not per tick", async () => {
    recordVerdict(root, drill(T0, true));
    let clock = T0;
    const sent: string[] = [];
    const url = "https://ntfy.example.com/topic";
    setNotifyUrl(app.db, admin.value.id, url);
    const n = startNotifier(app, {
      forgeUrl: "https://forge.example.com",
      now: () => clock,
      send: async (_u, body) => (sent.push(body), true),
    });
    await n.settled();
    // The baseline told nothing; a later tick on the same cause tells nothing.
    app.bus.append({ kind: "drill.finished", payload: {} });
    await n.settled();
    expect(sent).toHaveLength(0);
    // A new red drill is a new cause: one push, however many events follow.
    recordVerdict(root, drill(T0 + DAY, true));
    app.bus.append({ kind: "drill.finished", payload: {} });
    app.bus.append({ kind: "drill.finished", payload: {} });
    await n.settled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("failed at unseal");
    // Green clears; eight days of none is a new cause, told once.
    recordVerdict(root, drill(T0 + 2 * DAY, false));
    app.bus.append({ kind: "drill.finished", payload: {} });
    await n.settled();
    expect(sent).toHaveLength(1);
    clock = T0 + 2 * DAY + DRILL_STALE_MS + 1;
    app.bus.append({ kind: "drill.finished", payload: {} });
    app.bus.append({ kind: "drill.finished", payload: {} });
    await n.settled();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("No restore drill");
    await n.close();
  });

  test("eight days of silence alone, with no event, is pushed once by the clock", async () => {
    recordVerdict(root, drill(T0 + 10 * DAY, false));
    let clock = T0 + 11 * DAY;
    const sent: string[] = [];
    const n = startNotifier(app, {
      forgeUrl: "https://forge.example.com",
      now: () => clock,
      clockMs: 10,
      send: async (_u, body) => (sent.push(body), true),
    });
    await n.settled();
    expect(sent).toHaveLength(0);
    clock = T0 + 10 * DAY + DRILL_STALE_MS + 1;
    for (let i = 0; i < 100 && sent.length === 0; i++) await Bun.sleep(10);
    if (sent.length === 0) throw new Error(`never came: still waiting while sent.length === 0`);
    await n.settled();
    await Bun.sleep(50);
    await n.settled();
    await n.close();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("No restore drill");
  });

  test("a drill event is the admins' alone", () => {
    expect(eventAudience("drill.finished")).toBe("admins");
  });

  test("the terminal reads the same line as the board, for an admin only", () => {
    // The terminal's dashboard lists `forgeNeeds`, as the board's strip does.
    recordVerdict(root, drill(Date.now(), true));
    const needs = forgeNeeds(app, admin.value)!;
    expect(needs.filter((x) => x.includes("restore drill"))).toHaveLength(1);
    expect(forgeNeeds(app, undefined)).toBeUndefined();
  });
});
