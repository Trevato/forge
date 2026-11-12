/**
 * The slowest wait the forge relayed to an app, and whose it was (#10858):
 * when the forge's own loop lag explains more than half of `forge-ttfb`, the
 * app's speed card and terminal line say the forge was busy, not the app.
 */
import { beforeEach, expect, test } from "bun:test";
import { clearRelayWaits, KEEP_APPS, noteRelayWait, relayWait, relayWaitWords, WAIT_WINDOW_MS } from "../src/apps/relay_wait.ts";
import { visitorsLine, type AppVitals } from "../src/apps/vitals.ts";
import { appVisitorsView } from "../src/web/pages/settings.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const none: AppVitals = { today: 0, week: 0, ttfbP75: undefined, loadP75: undefined, lcpP75: undefined, inpP75: undefined, clsP75: undefined, loadDays: [] };

beforeEach(() => clearRelayWaits());

test("a wait the forge's lag explains is worded the forge's, escaped", () => {
  // 820 ms to headers, 600 ms of it the forge's loop: 600 > 820 / 2.
  noteRelayWait("a1", 820, 600, NOW);
  const wait = relayWait("a1", NOW)!;
  expect(wait.forge).toBe(true);
  expect(relayWaitWords(wait)).toBe("the forge was busy: 600 ms of the 820 ms wait");
  const page = String(appVisitorsView({ ...none, wait }));
  // One row beside the p75 facts, said once.
  expect(page).toContain("<dt>Slowest wait, 10 min</dt><dd>the forge was busy: 600 ms of the 820 ms wait</dd>");
  expect(page.match(/600 ms/g)).toHaveLength(1);
  expect(visitorsLine({ ...none, wait })).toEndWith(" · slowest wait, 10 min: the forge was busy: 600 ms of the 820 ms wait");
});

test("a wait the forge's lag does not explain is the app's own", () => {
  // 1.5 s to headers, 40 ms of lag: the app was slow.
  noteRelayWait("a1", 1500, 40, NOW);
  const wait = relayWait("a1", NOW)!;
  expect(wait.forge).toBe(false);
  expect(relayWaitWords(wait)).toBe("1.5 s, the app's own");
  const page = String(appVisitorsView({ ...none, wait }));
  expect(page).not.toContain("forge was busy");
  // The apostrophe is escaped on the page; the raw words never reach it.
  expect(page).not.toContain("app's own");
  expect(page).toMatch(/<dd>1\.5 s, the app&#(39|x27);s own<\/dd>/);
});

test("exactly half is the app's: more than half is the rule", () => {
  noteRelayWait("a1", 400, 200, NOW);
  expect(relayWait("a1", NOW)!.forge).toBe(false);
});

test("the slowest of the window is kept, and falls out after ten minutes", () => {
  noteRelayWait("a1", 300, 0, NOW);
  noteRelayWait("a1", 100, 90, NOW + 1);
  expect(relayWait("a1", NOW + 2)!.ttfbMs).toBe(300);
  expect(relayWait("a1", NOW + WAIT_WINDOW_MS)).toBeUndefined();
  // A stale reading is replaced by any newer one.
  noteRelayWait("a1", 50, 40, NOW + WAIT_WINDOW_MS);
  expect(relayWait("a1", NOW + WAIT_WINDOW_MS)).toMatchObject({ ttfbMs: 50, forge: true });
  // A malformed reading is not kept.
  noteRelayWait("a2", Number.NaN, 0, NOW);
  noteRelayWait("a2", 10, -1, NOW);
  expect(relayWait("a2", NOW)).toBeUndefined();
});

test("no reading, no words", () => {
  expect(String(appVisitorsView(none))).not.toContain("Slowest wait");
  expect(visitorsLine(none)).not.toContain("slowest wait");
});

test("at most KEEP_APPS apps are held, the stalest dropped first", () => {
  for (let i = 0; i <= KEEP_APPS; i++) noteRelayWait(`app${i}`, 10, 0, NOW + i);
  expect(relayWait("app0", NOW + KEEP_APPS)).toBeUndefined();
  expect(relayWait(`app${KEEP_APPS}`, NOW + KEEP_APPS)).toBeDefined();
});
