import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { diskSpec } from "../src/machines/disk_catalog.ts";
import { assessDisk, parseSmartJson, type DiskReading } from "../src/machines/disk_health.ts";

const raw = (n: string) => readFileSync(new URL(`./fixtures/smart/${n}.json`, import.meta.url), "utf8");
const read = (n: string): DiskReading => {
  const r = parseSmartJson(raw(n));
  if (r.kind !== "nvme") throw new Error(`fixture ${n} parsed as ${r.kind}`);
  return r;
};
const spec = diskSpec("Samsung SSD 980 PRO 1TB");

describe("catalog", () => {
  test("980 PRO 1TB ratings", () => {
    expect(spec).toEqual({ model: "Samsung SSD 980 PRO 1TB", ratedTbw: 600, warrantyYears: 5, warnTempC: 82, critTempC: 85 });
  });
  test("an unknown model is null, not a guess", () => {
    expect(diskSpec("Samsung SSD 980 PRO 2TB")).toBeNull();
    expect(diskSpec("samsung ssd 980 pro 1tb")).toBeNull();
    expect(diskSpec(undefined)).toBeNull();
  });
});

describe("parseSmartJson", () => {
  test("the 11-09 reading", () => {
    const r = read("healthy");
    expect(r).toMatchObject({ model: "Samsung SSD 980 PRO 1TB", firmware: "5B2QGXA7", capacityBytes: 1000204886016, percentageUsed: 0, availableSpare: 100, spareThreshold: 10, mediaErrors: 0, criticalWarning: 0, temperatureC: 39, warnTempMinutes: 0, critTempMinutes: 0, powerOnHours: 2575, unsafeShutdowns: 41 });
    // 1,074,219 data units × 512,000 B = 550.0 GB
    expect(r.bytesWritten).toBe(1074219 * 512000);
    expect(Math.round(r.bytesWritten / 1e9)).toBe(550);
  });
  test("a PERC virtual disk is behind a controller, never an SSD", () => {
    expect(parseSmartJson(raw("perc"))).toEqual({ kind: "behind-controller" });
  });
  test("bad input is a named refusal", () => {
    expect(parseSmartJson("nope")).toEqual({ kind: "refused", reason: "not-json" });
    expect(parseSmartJson("")).toEqual({ kind: "refused", reason: "not-json" });
    expect(parseSmartJson("[1]")).toEqual({ kind: "refused", reason: "not-smartctl-output" });
    expect(parseSmartJson('{"smartctl":{},"device":{"type":"sat"}}')).toEqual({ kind: "refused", reason: "no-nvme-health-log" });
    const doc = JSON.parse(raw("healthy"));
    doc.nvme_smart_health_information_log.media_errors = -1;
    expect(parseSmartJson(JSON.stringify(doc))).toEqual({ kind: "refused", reason: "bad-field", field: "media_errors" });
  });
});

describe("assessDisk", () => {
  test("healthy is ok, with or without a previous reading", () => {
    expect(assessDisk(read("healthy"), undefined, spec)).toEqual({ level: "ok", reasons: [] });
    expect(assessDisk(read("healthy"), read("healthy"), spec)).toEqual({ level: "ok", reasons: [] });
  });
  test("41 unsafe shutdowns alone is not an alert", () => {
    const r = { ...read("healthy"), unsafeShutdowns: 4100 };
    expect(assessDisk(r, { ...r, unsafeShutdowns: 41 }, spec).level).toBe("ok");
  });
  test("high temperature now, or time above warning, is not an alert", () => {
    const r = { ...read("healthy"), temperatureC: 84, warnTempMinutes: 900 };
    expect(assessDisk(r, read("healthy"), spec).level).toBe("ok");
  });
  test("a critical-warning bit", () => {
    const a = assessDisk({ ...read("healthy"), criticalWarning: 1 }, undefined, spec);
    expect(a.level).toBe("alert");
    expect(a.reasons.join()).toMatch(/critical warning/);
  });
  test("spare below threshold, but not at it", () => {
    const h = read("healthy");
    expect(assessDisk({ ...h, availableSpare: 9 }, undefined, spec).reasons.join()).toMatch(/spare/);
    expect(assessDisk({ ...h, availableSpare: 10 }, undefined, spec).level).toBe("ok");
  });
  test("percentage used ≥ 80, not 79", () => {
    const h = read("healthy");
    expect(assessDisk({ ...h, percentageUsed: 79 }, undefined, spec).level).toBe("ok");
    expect(assessDisk({ ...h, percentageUsed: 80 }, undefined, spec).level).toBe("alert");
    expect(assessDisk(read("worn"), undefined, spec).reasons.join()).toMatch(/percentage used 82%/);
  });
  test("media errors only when higher than the previous reading", () => {
    const h = read("healthy");
    const e = { ...h, mediaErrors: 3 };
    expect(assessDisk(e, h, spec).reasons.join()).toMatch(/media errors rose from 0 to 3/);
    expect(assessDisk(e, e, spec).level).toBe("ok");
    expect(assessDisk(e, undefined, spec).level).toBe("ok");
  });
  test("critical-temperature minutes only when rising", () => {
    const h = read("healthy");
    const hot = read("hot");
    expect(assessDisk(hot, h, spec).reasons.join()).toMatch(/critical temperature rose from 0 to 57/);
    expect(assessDisk(hot, hot, spec).level).toBe("ok");
    expect(assessDisk(hot, undefined, spec).level).toBe("ok");
  });
  test("failing: warning bit and spare below threshold both named", () => {
    const a = assessDisk(read("failing"), read("healthy"), spec);
    expect(a.level).toBe("alert");
    expect(a.reasons.length).toBe(3); // bits, spare, media errors 0 → 12
  });
  test("an unknown model assesses the same", () => {
    expect(assessDisk(read("worn"), undefined, null).level).toBe("alert");
  });
});
