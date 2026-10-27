/** FLOW ONLY (#6395): the alarm line offers the switch; 24 h clear turns it off, once. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { candidatesFor } from "../src/feed/items.ts";
import { FLOW_ONLY_CLEAR_MS, stepFlowOnly } from "../src/flow/flow_only_auto.ts";
import { tickFlowOnly } from "../src/flow/clog_tick.ts";
import type { FiredAlarm } from "../src/flow/alarms.ts";
import { flowRow } from "../src/tui/screens/about.ts";
import { alarmLines, flowOnlyOffer } from "../src/web/studio/alarm_lines.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App;
let alice: User;
let repo: Repo;
let was: string | undefined;
const T0 = Date.UTC(2026, 9, 1);
const fresh = (): Repo => getRepoById(app.db, repo.id)!;
const events = (): number =>
  app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM event WHERE kind = 'flow_only.cleared'").get()!.n;

beforeAll(async () => {
  was = process.env.FORGE_SENTINEL_REPO;
  process.env.FORGE_SENTINEL_REPO = "alice/forge";
  dataDir = await mkdtemp(join(tmpdir(), "forge-flow-only-auto-"));
  app = createApp({ dataDir, port: 0 });
  const a = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-long-flow-only-passphrase",
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
  const made = await createRepo(app, alice, { name: "forge", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
}, 60_000);

afterAll(async () => {
  if (was === undefined) delete process.env.FORGE_SENTINEL_REPO;
  else process.env.FORGE_SENTINEL_REPO = was;
  await rm(dataDir, { recursive: true, force: true });
});

const alarm: FiredAlarm = { key: "red_main", says: "Main is red", since: "x", href: "/boards" };

test("an alarm line carries the Flow only button while the switch is off, for the admin", () => {
  expect(flowOnlyOffer(app.db, alice)).toBe("alice/forge");
  const page = String(alarmLines([alarm], "alice/forge"));
  expect(page).toContain('action="/alice/forge/settings/flow-only"');
  expect(page).toContain('name="flowOnly" value="1"');
  expect(page).toContain("Flow only");
  expect(String(alarmLines([alarm]))).not.toContain("<form");
});

test("no offer once the switch is on", async () => {
  await updateRepoSettings(app, alice, repo, { flowOnly: true });
  expect(flowOnlyOffer(app.db, alice)).toBeUndefined();
});

test("24 h clear turns it off once and says so; an alarm within the 24 h keeps it on", () => {
  expect(fresh().flowOnly).toBe(true);
  // The clock starts when the switch is first seen on.
  expect(stepFlowOnly(app.db, app.bus, fresh(), false, T0)).toBe(false);
  // An alarm 23 h in restarts the clock.
  expect(stepFlowOnly(app.db, app.bus, fresh(), true, T0 + 23 * 3_600_000)).toBe(false);
  expect(stepFlowOnly(app.db, app.bus, fresh(), false, T0 + FLOW_ONLY_CLEAR_MS + 1)).toBe(false);
  expect(fresh().flowOnly).toBe(true);
  // 24 h after that alarm, quiet: off, once.
  const off = T0 + 23 * 3_600_000 + FLOW_ONLY_CLEAR_MS;
  expect(stepFlowOnly(app.db, app.bus, fresh(), false, off)).toBe(true);
  expect(fresh().flowOnly).toBe(false);
  expect(stepFlowOnly(app.db, app.bus, fresh(), false, off + 60_000)).toBe(false);
  expect(events()).toBe(1);
  const mine = candidatesFor(app.db, alice, off).filter((c) => c.what.includes("Flow only is off again"));
  expect(mine).toHaveLength(1);
});

test("the tick steps the own repository's watch", async () => {
  await updateRepoSettings(app, alice, fresh(), { flowOnly: true });
  const now = new Date(T0);
  expect(tickFlowOnly(app.db, app.bus, now)).toBe(false);
  expect(fresh().flowOnly).toBe(true);
  expect(tickFlowOnly(app.db, app.bus, new Date(T0 + FLOW_ONLY_CLEAR_MS + 1))).toBe(true);
  expect(fresh().flowOnly).toBe(false);
});

test("the tick counts the alarms the home shows: a crew ceiling that silences idle-crew does not hold the switch on", async () => {
  const { openIssue } = await import("../src/actions/issues.ts");
  const { createRun } = await import("../src/core/runs.ts");
  await updateRepoSettings(app, alice, fresh(), {
    autonomy: "assisted",
    autonomyDirection: "keep the shop open",
    autonomySlots: 2,
    autonomyCeilingUsd: 15,
    autonomyBy: alice.id,
  });
  const issue = openIssue(app, alice, fresh(), { title: "Waiting" });
  if (!issue.ok) throw new Error(String(issue.error));
  const now = T0 + 400 * 24 * 3_600_000 + 12 * 3_600_000;
  const iso = (ms: number): string => new Date(ms).toISOString();
  app.db.query("UPDATE issue SET created_at = ?1 WHERE id = ?2").run(iso(now - 3_600_000), issue.value.id);
  const run = createRun(app.db, { repoId: repo.id, kind: "agent", reason: "assigned" });
  app.db
    .query("UPDATE run SET created_at = ?1, started_at = ?1, state = 'ok', cost_usd = 50 WHERE id = ?2")
    .run(iso(now - 20 * 60_000), run.id);
  await updateRepoSettings(app, alice, fresh(), { flowOnly: true });
  app.db.query("DELETE FROM flow_only_watch").run();
  // No ceiling: the idle crew is an alarm that stands, and holds the switch on.
  expect(tickFlowOnly(app.db, app.bus, new Date(now))).toBe(false);
  expect(tickFlowOnly(app.db, app.bus, new Date(now + FLOW_ONLY_CLEAR_MS + 1))).toBe(false);
  expect(fresh().flowOnly).toBe(true);
  // A $40 ceiling the day's spend has reached: the home shows no such alarm, so the watch lets go.
  const later = now + 24 * 3_600_000 + 1 + FLOW_ONLY_CLEAR_MS;
  const spent = createRun(app.db, { repoId: repo.id, kind: "agent", reason: "assigned" });
  app.db
    .query("UPDATE run SET created_at = ?1, started_at = ?1, state = 'ok', cost_usd = 50 WHERE id = ?2")
    .run(iso(later - 20 * 60_000), spent.id);
  expect(tickFlowOnly(app.db, app.bus, new Date(later), 40)).toBe(true);
  expect(fresh().flowOnly).toBe(false);
});

test("the terminal's About row says the forge lets go by itself, on the own repository only", () => {
  const on = { ...fresh(), flowOnly: true };
  expect(flowRow(on)[0]![1]).toBe("on, off after 24 h clear");
  expect(flowRow({ ...on, name: "other" })[0]![1]).toBe("on");
  expect(flowRow({ ...on, flowOnly: false })[0]![1]).toBe("off");
});
