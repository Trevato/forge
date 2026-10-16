import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drillCommand, domainDrillNeeds, type NewestDrill } from "../src/kernel/domain_drill.ts";
import { DOMAINS } from "../src/kernel/domains.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const DAY = 86_400_000;
const URL_ = "https://forge.example";
const iso = (ms: number) => new Date(ms).toISOString();
const drilled = DOMAINS.filter((d) => d.drill.name !== null).map((d) => d.key);
const green = (domain: string, at: number): NewestDrill => ({ domain, green: true, why: "ok", at: iso(at) });
const needs = (newest: NewestDrill[], since = iso(NOW - 30 * DAY)) =>
  domainDrillNeeds(newest, NOW, since, URL_, DOMAINS);

test("a red drill raises its domain's need, naming the phrase and the command", () => {
  const rest = drilled.filter((k) => k !== "snapshots").map((k) => green(k, NOW - DAY));
  const red: NewestDrill = { domain: "snapshots", green: false, why: 'the forge never said "The restore drill failed at"', at: iso(NOW - DAY) };
  const n = needs([...rest, red]);
  expect(n.map((x) => x.cause)).toEqual(["drill:snapshots"]);
  expect(n[0]!.sentence).toContain('The restore drill failed at');
  expect(n[0]!.sentence).toContain(`bun scripts/drills/run.ts snapshots --forge ${URL_}`);
});

test("a newer green drill clears the need", () => {
  const all = drilled.map((k) => green(k, NOW - DAY));
  expect(needs(all)).toEqual([]);
});

test("eight days is the edge: exactly eight is quiet, a millisecond over speaks", () => {
  const rest = drilled.slice(1).map((k) => green(k, NOW - DAY));
  const key = drilled[0]!;
  expect(needs([green(key, NOW - 8 * DAY), ...rest])).toEqual([]);
  const n = needs([green(key, NOW - 8 * DAY - 1), ...rest]);
  expect(n.map((x) => x.cause)).toEqual([`drill:${key}`]);
});

test("domains never drilled are one need, once the forge is over eight days old", () => {
  const n = needs([]);
  expect(n.length).toBe(1);
  expect(n[0]!.cause).toBe("drill:never");
  for (const k of drilled) expect(n[0]!.sentence).toContain(drillCommand(k, URL_));
  expect(needs([], iso(NOW - 8 * DAY))).toEqual([]);
  expect(needs([], iso(NOW - 8 * DAY - 1)).length).toBe(1);
  expect(domainDrillNeeds([], NOW, undefined, URL_, DOMAINS)).toEqual([]);
});

test("domains that cannot be drilled are never asked for", () => {
  expect(needs([]).map((x) => x.sentence).join(" ")).not.toContain("scripts/drills/run.ts edge");
});

test("the command is the real key and URL, shell-escaped", () => {
  expect(drillCommand("compute", "https://f.example:8443")).toBe(
    "bun scripts/drills/run.ts compute --forge https://f.example:8443",
  );
  expect(drillCommand("a b", "http://x/?q=1&r='2'")).toBe(
    `bun scripts/drills/run.ts 'a b' --forge 'http://x/?q=1&r='\\''2'\\'''`,
  );
  expect(drillCommand("x; rm -rf /", URL_)).toContain("'x; rm -rf /'");
});

test("a verdict that is not a quoted phrase is quoted whole, and bounded", () => {
  const rest = drilled.filter((k) => k !== "runner").map((k) => green(k, NOW - DAY));
  const why = "back after 900s, " + "x".repeat(500);
  const n = needs([...rest, { domain: "runner", green: false, why, at: iso(NOW) }]);
  expect(n[0]!.sentence).toContain("back after 900s");
  expect(n[0]!.sentence.length).toBeLessThan(400);
});

test("vitals raises them from the newest drill of each domain, in one query", async () => {
  const { vitals } = await import("../src/kernel/vitals.ts");
  const { newestDrills, recordDrill } = await import("../src/core/domain_drills.ts");
  const { createApp } = await import("../src/app.ts");
  const dir = mkdtempSync(join(tmpdir(), "vdd-"));
  const app = createApp({ dataDir: dir, port: 0 });
  const seen = { health: "", board: "" };
  recordDrill(app.db, "u", "compute", seen, 1, { green: false, why: 'the forge never said "x"' });
  const sentence = () =>
    vitals({ db: app.db, signals: app.signals, dataDir: dir, forgeUrl: URL_ }).needs.find((s) => s.includes("compute drill"));
  expect(sentence()).toContain(`bun scripts/drills/run.ts compute --forge ${URL_}`);
  app.db.query("UPDATE domain_drill SET at = '2020-01-01T00:00:00.000Z'").run();
  recordDrill(app.db, "u", "compute", seen, 1, { green: true, why: "ok" });
  expect(sentence()).toBeUndefined();
  expect(newestDrills(app.db).length).toBe(1);
});
