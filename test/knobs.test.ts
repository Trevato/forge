/**
 * The five knobs (#10461): read in plain words, turned in place, and each
 * turn read by the next pump; the pipeline's own dials stay on the capacity page.
 */

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeCapacity } from "../src/actions/capacity.ts";
import { createRepo } from "../src/actions/repos.ts";
import { setKnob } from "../src/actions/knobs.ts";
import { createApp, type App } from "../src/app.ts";
import { listCapacity } from "../src/actions/capacity.ts";
import { CAPACITY_KEYS, capacityCount, capacityValue, paceFloor, queueDepth, setCapacity, weekUse } from "../src/core/capacity.ts";
import { listEvents } from "../src/core/events.ts";
import { getRepoById } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { knobLines, readKnobs } from "../src/crew/knobs.ts";
import { weekDecision } from "../src/crew/week.ts";
import { tool } from "../src/http/mcp/tools/knobs.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let admin: User;
let bob: User;
let repoId: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-knobs-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  admin = await mk("carol", true);
  bob = await mk("bob");
  const made = await createRepo(app, admin, { name: "site", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  repoId = made.value.id;
}, 30_000);
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("the panel has Speed, the derived pace floor and queue depth, Weekly budget, Polish share, Autonomy per repository and Feedback first, each with an effect", () => {
  const rows = readKnobs(app);
  expect(rows.map((r) => r.id)).toEqual(["speed", "floor", "depth", "budget", "reserve", "polish", "autonomy", "feedback"]);
  for (const r of rows) {
    expect(r.does.length).toBeGreaterThan(0);
    expect(r.effect.length).toBeGreaterThan(0);
  }
  expect(rows[0]!.effect).toMatch(/\d+ running · \d+ queued/);
  expect(rows[7]!.effect).toBe("nothing from a person waiting");
  expect(knobLines(rows)).toHaveLength(8);
});

test("Speed 4 → 2 is read by the next pump", async () => {
  setCapacity(app.db, "crew.concurrency", "4", admin.id);
  expect((await setKnob(app, admin, "speed", "2")).ok).toBe(true);
  // The pump asks exactly this, with the number it booted on as the fallback.
  expect(capacityCount(app.db, "crew.concurrency", 4)).toBe(2);
  expect(readKnobs(app)[0]!.value).toBe("2");
  expect((await setKnob(app, admin, "speed", "99")).ok).toBe(false);
  expect(listEvents(app.db, {}).some((e) => e.kind === "capacity.changed")).toBe(true);
});

test("the small share and the polish cap are gone from capacity; a stored old value is ignored", () => {
  for (const key of ["slots.smallShare", "polish.capMinutes"]) expect(CAPACITY_KEYS as string[]).not.toContain(key);
  app.db.query("INSERT OR REPLACE INTO forge_setting (key, value, updated_by, updated_at) VALUES ('slots.smallShare', '5', ?1, ?2)").run(admin.id, new Date().toISOString());
  const listed = listCapacity(app, admin);
  if (!listed.ok) throw new Error("not admin");
  expect(listed.value.settings.map((r) => r.key)).not.toContain("slots.smallShare");
  expect(readKnobs(app).length).toBeGreaterThan(0);
});

test("no knob or capacity POST sets the pace floor or the queue depth: a plain line, nothing stored", async () => {
  for (const knob of ["queue.depth", "pace.floor", "floor", "depth", "slots.smallShare"]) expect((await setKnob(app, admin, knob, "1")).ok).toBe(false);
  const knob = await setKnob(app, admin, "pace.floor", "1");
  expect(!knob.ok && knob.error).toBe("derived");
  for (const key of ["pace.floor", "queue.depth"]) {
    const changed = changeCapacity(app, admin, key, "3");
    expect(!changed.ok && changed.error).toBe("derived");
    expect(app.db.query("SELECT 1 FROM forge_setting WHERE key = ?1").get(key)).toBeNull();
  }
});

test("Reserve is a read-only row: 100 minus Weekly budget, and a set is refused with a plain line", async () => {
  const before = capacityValue(app.db, "week.use");
  // Weekly budget cannot go below 10, so Reserve tops out at 90 here; 0 is not a value a set can reach.
  for (const use of ["10", "50", "100"]) {
    expect((await setKnob(app, admin, "budget", use)).ok).toBe(true);
    const row = readKnobs(app).find((r) => r.id === "reserve")!;
    expect(row.control).toBe("derived");
    expect(row.value).toBe(String(100 - Number(use)));
    expect(row.does).toContain("What Weekly budget leaves");
    expect(row.follows).toBe("Weekly budget");
    expect(knobLines([row])[0]).toContain(`Reserve: ${100 - Number(use)}%`);
  }
  const set = await setKnob(app, admin, "reserve", "20");
  expect(!set.ok && set.error).toBe("derived");
  const mcp = await tool.run({ app, auth: { scope: "admin" } } as never, admin, { knob: "reserve", value: "20", dryRun: false });
  expect(JSON.stringify(mcp)).toContain("Weekly budget");
  expect(weekUse(app.db)).toBe(100);
  setCapacity(app.db, "week.use", before, admin.id);
});

test("Weekly budget sets the reserve the pacer holds back", () => {
  expect(weekUse(app.db)).toBe(90);
  const week = (reserve: number) =>
    weekDecision({
      meter: { freePct: 20, keptPct: 0, burnPctPerHour: 1, resetsAt: new Date(Date.now() + 3 * 86_400_000) },
      now: new Date(),
      ceiling: 4,
      floorSlots: 1,
      idleSlots: 0,
      startable: 0,
      gated: 0,
      reserve,
    })!;
  expect(week(0.1).slots).toBeGreaterThan(0);
  expect(week(0.9).slots).toBe(0);
});

test("Autonomy turns ask and go into the repository's settings; Polish share sets its share", async () => {
  expect((await setKnob(app, admin, "autonomy", "ask", "carol/site")).ok).toBe(true);
  let repo = getRepoById(app.db, repoId)!;
  expect([repo.autonomy, repo.plansNeedNod, repo.decisionsBy]).toEqual(["autonomous", true, "me"]);
  expect((await setKnob(app, admin, "autonomy", "go", "carol/site")).ok).toBe(true);
  repo = getRepoById(app.db, repoId)!;
  expect([repo.plansNeedNod, repo.decisionsBy]).toEqual([false, "decider"]);
  expect(readKnobs(app).find((r) => r.id === "autonomy" && r.repo === "carol/site")!.value).toBe("go");
  expect((await setKnob(app, admin, "polish", "20")).ok).toBe(true);
  expect(getRepoById(app.db, repoId)!.polishShare).toBe(20);
  expect((await setKnob(app, admin, "polish", "70")).ok).toBe(false);
  expect((await setKnob(app, admin, "autonomy", "maybe", "carol/site")).ok).toBe(false);
  expect(listEvents(app.db, {}).some((e) => e.kind === "repo.settings_updated")).toBe(true);
  expect((await setKnob(app, admin, "autonomy", "off", "carol/site")).ok).toBe(true);
});

test("only a forge admin turns a knob, and the MCP tool says the same words", async () => {
  expect((await setKnob(app, bob, "speed", "3")).ok).toBe(false);
  const ctx = { app, auth: { scope: "admin" } } as never;
  const read = (await tool.run(ctx, admin, {})) as { content?: unknown };
  expect(JSON.stringify(read)).toContain("Weekly budget");
  const dry = await tool.run(ctx, admin, { knob: "speed", value: "3" });
  expect(JSON.stringify(dry)).toContain("Would set speed");
  expect(JSON.stringify(await tool.run(ctx, bob, {}))).toContain("not_found");
});

afterEach(() => {
  for (const key of ["crew.concurrency", "pace.floor", "queue.depth"] as const) setCapacity(app.db, key, null, admin.id);
});

test("pace floor and queue depth follow Speed, and the next pump reads the new floor", async () => {
  setCapacity(app.db, "crew.concurrency", "6", admin.id);
  expect(paceFloor(app.db)).toBe(3);
  expect(queueDepth(app.db)).toBe(3);
  // The dispatch pump asks paceFloor on every pass: turning Speed moves it at once.
  expect((await setKnob(app, admin, "speed", "1")).ok).toBe(true);
  expect(paceFloor(app.db)).toBe(1);
  expect(queueDepth(app.db)).toBe(1);
});

test("a stored pace floor or queue depth is ignored: Speed decides", () => {
  setCapacity(app.db, "crew.concurrency", "6", admin.id);
  setCapacity(app.db, "pace.floor", "2", admin.id);
  setCapacity(app.db, "queue.depth", "4", admin.id);
  expect(paceFloor(app.db)).toBe(3);
  expect(queueDepth(app.db)).toBe(3);
});

test("the derivation at the lowest, middle and highest Speed", () => {
  const at = (speed: string) => {
    setCapacity(app.db, "crew.concurrency", speed, admin.id);
    return [paceFloor(app.db), queueDepth(app.db)];
  };
  expect(at("1")).toEqual([1, 1]);
  expect(at("8")).toEqual([4, 4]);
  expect(at("16")).toEqual([8, 4]);
});

test("the capacity page and the knobs list the derived dials with their value, read-only", async () => {
  setCapacity(app.db, "crew.concurrency", "6", admin.id);
  const rows = listCapacity(app, admin);
  if (!rows.ok) throw new Error("not admin");
  for (const key of ["pace.floor", "queue.depth"]) {
    const r = rows.value.settings.find((x) => x.key === key)!;
    expect(r.source).toBe("derived");
    expect(r.value).toBe("3");
  }
  const knobs = readKnobs(app);
  for (const [id, unit] of [["floor", "slots"], ["depth", "candidates"]]) {
    const r = knobs.find((x) => x.id === id)!;
    expect([r.control, r.value, r.effect]).toEqual(["derived", "3", `3 ${unit}`]);
  }
  // The MCP tool prints the same rows, in the same words.
  const ctx = { app, auth: { scope: "admin" } } as never;
  expect(JSON.stringify(await tool.run(ctx, admin, {}))).toContain("Pace floor: 3 — 3 slots");
});

test("the knobs card renders the derived dials as plain values with no form", async () => {
  const { knobsCard } = await import("../src/web/pages/knobs.ts");
  const out = String(knobsCard({ app } as never));
  for (const id of ["floor", "depth"]) {
    const row = out.slice(out.indexOf(`data-knob="${id}"`), out.indexOf("</div>", out.indexOf(`data-knob="${id}"`)));
    expect(row).toContain(`data-derived="${id}"`);
    expect(row).not.toContain("<form");
    expect(row).not.toContain("<input");
  }
});
