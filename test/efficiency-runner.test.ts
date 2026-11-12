/** The duty through the runner (#7558): `app` reaches it, so findings stand and a missing FORGE_REPO says why nothing was filed. */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { HOUR_MS, hourStart } from "../src/efficiency/baseline.ts";
import { noteInstall, resetInstalls } from "../src/efficiency/installs.ts";
import { putSample } from "../src/efficiency/store.ts";
import { watch } from "../src/efficiency/watch.ts";
import { duty } from "../src/maintain/duties/efficiency_watcher.ts";
import { duties } from "../src/maintain/registry.ts";
import { startMaintain } from "../src/maintain/runner.ts";
import { latest } from "../src/maintain/runs.ts";
import { runLines } from "../src/tui/screens/maintainruns.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
const HIT = "install-cache-hit-rate";
let root = "";
let app: App;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "forge-efficiency-run-"));
  app = createApp({ dataDir: root, port: 0 }); // no FORGE_REPO
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  resetInstalls();
  app.db.exec("DELETE FROM efficiency_sample; DELETE FROM maintenance_run");
});

/** A week of 95% hit rates, a bad hour before `now`, and this hour's installs all missing. */
function falling(now: number): void {
  const hour = hourStart(now);
  for (let h = 2; h <= 8 * 24; h++) putSample(app.db, HIT, hour - h * HOUR_MS, 0.95);
  putSample(app.db, HIT, hour - HOUR_MS, 0.1);
  for (let i = 0; i < 6; i++) noteInstall(true, now - 1000);
}

test("run by the runner with the app, the duty finds the fall; the admin screen lists it", async () => {
  expect(duties.map((d) => d.name)).toContain("efficiency-watcher");
  const now = Date.now();
  falling(now);
  const m = startMaintain(app, { duties: [duty], everyMs: 1e9 });
  m.stop();
  await m.tick(new Date(now));
  const [row] = latest(app.db, 1);
  expect(row!.duty).toBe("efficiency-watcher");
  expect(row!.outcome).toBe("ok");
  expect(row!.findings.length).toBeGreaterThanOrEqual(1);
  expect(JSON.stringify(row!.findings)).toContain("install cache hit rate");
  expect(row!.probes.length).toBe(row!.findings.length);
  const as = (isAdmin: boolean) => ({ user: { isAdmin }, db: app.db }) as never;
  expect(runLines(as(true)).some((l) => l.startsWith("efficiency-watcher"))).toBe(true);
  expect(runLines(as(false))).toEqual([]);
});

test("without FORGE_REPO the findings stand but the run says why nothing was filed", async () => {
  const now = Date.now();
  falling(now);
  const m = startMaintain(app, { duties: [duty], everyMs: 1e9 });
  m.stop();
  await m.tick(new Date(now));
  const [row] = latest(app.db, 1);
  expect(row!.actions.join("\n")).toContain("filed nothing: FORGE_REPO is not set");
  expect(app.db.query("SELECT COUNT(*) AS n FROM issue").get()).toEqual({ n: 0 });
});

test("a FORGE_REPO that names no repository says so", () => {
  const now = Date.now();
  falling(now);
  const other = createApp({ dataDir: mkdtempSync(join(tmpdir(), "forge-efficiency-run2-")), port: 0, forgeRepo: "ghost/forge" });
  const hour = hourStart(now);
  for (let h = 2; h <= 8 * 24; h++) putSample(other.db, HIT, hour - h * HOUR_MS, 0.95);
  putSample(other.db, HIT, hour - HOUR_MS, 0.1);
  const r = watch(other, now, { [HIT]: 0.1 });
  expect(r.actions.join("\n")).toContain('names no repository on this forge');
});
