import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { clearedOf, forgetMeasure, measureFor, MEASURE_TRUST_MS, noteMeasure } from "../src/core/measure.ts";

const db = new Database(":memory:");
db.run("CREATE TABLE subscription_measure (subscription_id TEXT NOT NULL, span TEXT NOT NULL, used_pct REAL NOT NULL, resets_at TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY (subscription_id, span))");
db.run("CREATE TABLE subscription (id TEXT PRIMARY KEY)");
db.run("INSERT INTO subscription (id) VALUES ('platform')");
const at = Date.parse("2026-11-12T18:17:10Z");
const reading = { window: "week" as const, usedPct: 99, resetsAt: "2026-11-15T02:00:00.000Z", observedAt: new Date(at).toISOString() };

test("a reading is believed for six hours and then dropped, so a reset meter is heard", () => {
  noteMeasure(db, "platform", reading);
  expect(measureFor(db, "platform", "week", new Date(at + MEASURE_TRUST_MS - 1))?.usedPct).toBe(99);
  expect(measureFor(db, "platform", "week", new Date(at + MEASURE_TRUST_MS + 1))).toBeNull();
});

test("a rate-limit event with no utilization names the window that is clear, and the reading goes", () => {
  noteMeasure(db, "platform", { ...reading, observedAt: new Date().toISOString(), resetsAt: new Date(Date.now() + 86_400_000).toISOString() });
  const event = { type: "rate_limit_event", rate_limit_info: { rateLimitType: "seven_day", status: "allowed", resetsAt: 1794708000 } };
  expect(clearedOf(event)).toBe("week");
  forgetMeasure(db, "platform", clearedOf(event)!);
  expect(measureFor(db, "platform", "week", new Date())).toBeNull();
});

test("an event that carries a utilization, or a refusal, clears nothing", () => {
  expect(clearedOf({ type: "rate_limit_event", rate_limit_info: { rateLimitType: "seven_day", utilization: 0.99, resetsAt: 1 } })).toBeUndefined();
  expect(clearedOf({ type: "rate_limit_event", rate_limit_info: { rateLimitType: "five_hour", status: "rejected" } })).toBeUndefined();
  expect(clearedOf({ type: "assistant" })).toBeUndefined();
});
