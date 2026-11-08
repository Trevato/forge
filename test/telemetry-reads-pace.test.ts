import { beforeEach, expect, test } from "bun:test";
import { countRead, readerPaces, resetTelemetryReads, telemetryReadsFamily } from "../src/system/telemetry_reads.ts";
import { readersSection } from "../src/web/pages/system.ts";

beforeEach(resetTelemetryReads);
const T0 = 1_700_000_000_000;

test("reads 1 s apart are flagged on flow, 6 s apart are not", () => {
  for (let i = 0; i < 10; i++) countRead("flow", "fast", T0 + i * 1000);
  for (let i = 0; i < 10; i++) countRead("flow", "slow", T0 + i * 6000);
  for (let i = 0; i < 10; i++) countRead("history", "other-route", T0 + i * 1000);
  const p = Object.fromEntries(readerPaces(T0 + 60_000).map((r) => [r.reader, r]));
  expect(p.fast!.tooFast).toBe(true);
  expect(p.fast!.meanIntervalMs).toBe(1000);
  expect(p.fast!.reads).toBe(10);
  expect(p.slow!.tooFast).toBe(false);
  expect(p["other-route"]!.tooFast).toBe(false);
});

test("reads older than 10 minutes drop out; at most one slot per second", () => {
  countRead("flow", "a", T0);
  for (let i = 0; i < 5; i++) countRead("flow", "a", T0 + 599_000);
  expect(readerPaces(T0 + 599_500)[0]!.reads).toBe(6);
  expect(readerPaces(T0 + 601_000)[0]!.reads).toBe(5);
  expect(readerPaces(T0 + 1_300_000)).toEqual([]);
});

test("the 201st reader is counted under other, and /metrics is unchanged", () => {
  for (let i = 0; i < 201; i++) countRead("flow", `r${i}`, T0);
  const paces = readerPaces(T0);
  expect(paces.length).toBe(201);
  expect(paces.find((r) => r.reader === "other")!.reads).toBe(1);
  expect(paces.find((r) => r.reader === "r200")).toBeUndefined();
  expect(telemetryReadsFamily().samples.length).toBe(201);
});

test("the section escapes names, flags, and says so when empty", () => {
  expect(readersSection([]).text).toContain("No telemetry reads in the last 10 minutes.");
  countRead("flow", "<b>x</b>", T0);
  countRead("flow", "<b>x</b>", T0 + 1000);
  const text = readersSection(readerPaces(T0 + 2000)).text;
  expect(text).toContain("&lt;b&gt;x&lt;/b&gt;");
  expect(text).not.toContain("<b>x</b>");
  expect(text).toContain("faster than the flow copy changes");
});
