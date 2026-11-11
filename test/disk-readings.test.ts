/** Disk readings per machine (#10465): rate, projected date, refusals, alerts. Hand calculation in comments. */
import { expect, test } from "bun:test";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";
import { diskSummary, MAX_DEVICES, MAX_MACHINES, recordReading } from "../src/machines/disk_readings.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");

function smart(units: number, mediaErrors = 0, model = "Samsung SSD 980 PRO 1TB") {
  return JSON.stringify({
    smartctl: { version: [7, 4] },
    device: { name: "/dev/nvme0", type: "nvme", protocol: "NVMe" },
    model_name: model,
    firmware_version: "5B2QGXA7",
    user_capacity: { bytes: 1_000_204_886_016 },
    nvme_smart_health_information_log: {
      critical_warning: 0, temperature: 40, available_spare: 100, available_spare_threshold: 10,
      percentage_used: 1, data_units_written: units, media_errors: mediaErrors, power_on_hours: 100,
      unsafe_shutdowns: 2, warning_temp_time: 0, critical_comp_time: 0,
    },
  });
}
const db = () => openDb(":memory:", migrations);

test("two readings 30 days apart give the rate and the date", () => {
  const d = db();
  // 1e9 data units × 512 000 B = 5.12e14 B; 2e9 units = 1.024e15 B. Δ = 5.12e14 B over 30 d.
  recordReading(d, "m1", "nvme0", smart(1_000_000_000), T0, { cpu: "AMD EPYC", memoryBytes: 64e9 });
  recordReading(d, "m1", "nvme0", smart(2_000_000_000), T0 + 30 * DAY);
  const s = diskSummary(d, "m1");
  expect(s.cpu).toBe("AMD EPYC");
  expect(s.memoryBytes).toBe(64e9);
  const dev = s.devices[0]!;
  if (dev.kind !== "nvme") throw new Error("kind");
  expect(dev.bytesWrittenInWindow).toBe(512_000_000_000_000);
  expect(dev.inventory.model).toBe("Samsung SSD 980 PRO 1TB");
  // Remaining: 600e12 − 1.024e15 < 0 → already past rated: date is the latest reading, 2026-10-31.
  expect(dev.ratedReachedAt).toBe("2026-10-31");
});

test("projects forward: remaining ÷ rate", () => {
  const d = db();
  // 100e6 units = 5.12e13 B; 200e6 units = 1.024e14 B; Δ = 5.12e13 over 30 d.
  // Remaining = 6e14 − 1.024e14 = 4.976e14; ÷ (5.12e13/30 per day) = 291.5625 d after 2026-10-31.
  recordReading(d, "m1", "nvme0", smart(100_000_000), T0);
  recordReading(d, "m1", "nvme0", smart(200_000_000), T0 + 30 * DAY);
  const dev = diskSummary(d, "m1").devices[0]!;
  const expected = new Date(T0 + 30 * DAY + 291.5625 * DAY).toISOString().slice(0, 10);
  expect(dev.ratedReachedAt).toBe(expected);
});

test("one reading gives no projection; unknown model gives no date", () => {
  const d = db();
  recordReading(d, "m1", "nvme0", smart(5), T0);
  const one = diskSummary(d, "m1").devices[0]!;
  expect(one.bytesWrittenInWindow).toBeNull();
  expect(one.ratedReachedAt).toBeNull();
  recordReading(d, "m2", "nvme0", smart(5, 0, "Mystery"), T0);
  recordReading(d, "m2", "nvme0", smart(9, 0, "Mystery"), T0 + DAY);
  const two = diskSummary(d, "m2").devices[0]!;
  if (two.kind !== "nvme") throw new Error("kind");
  expect(two.spec).toBeNull();
  expect(two.bytesWrittenInWindow).toBe(4 * 512_000);
  expect(two.ratedReachedAt).toBeNull();
});

test("a refused reading stores nothing and names why", () => {
  const d = db();
  expect(recordReading(d, "m1", "nvme0", "nope", T0)).toEqual({ ok: false, reason: "not-json" });
  expect(recordReading(d, "m1", "nvme0", '{"a":1}', T0)).toEqual({ ok: false, reason: "not-smartctl-output" });
  expect(recordReading(d, "bad name", "nvme0", smart(1), T0)).toEqual({ ok: false, reason: "bad-machine" });
  expect(recordReading(d, "m1", "nvme0", smart(1), T0, { cpu: "", memoryBytes: 1 })).toEqual({ ok: false, reason: "bad-inventory" });
  expect(d.query("SELECT COUNT(*) AS n FROM disk_reading").get()).toEqual({ n: 0 });
  expect(d.query("SELECT COUNT(*) AS n FROM machine_inventory").get()).toEqual({ n: 0 });
  expect(diskSummary(d, "m1").devices).toEqual([]);
});

test("rising media errors between two stored readings alert", () => {
  const d = db();
  recordReading(d, "m1", "nvme0", smart(10, 0), T0);
  const first = diskSummary(d, "m1").devices[0]!;
  if (first.kind !== "nvme") throw new Error("kind");
  expect(first.assessment.level).toBe("ok");
  recordReading(d, "m1", "nvme0", smart(11, 3), T0 + DAY);
  const dev = diskSummary(d, "m1").devices[0]!;
  if (dev.kind !== "nvme") throw new Error("kind");
  expect(dev.assessment.level).toBe("alert");
  expect(dev.assessment.reasons[0]).toContain("media errors rose from 0 to 3");
});

test("a counter that goes backwards gives no rate and no date", () => {
  const d = db();
  recordReading(d, "m1", "nvme0", smart(200_000_000), T0);
  recordReading(d, "m1", "nvme0", smart(100_000_000), T0 + DAY); // a replaced or reset drive
  const dev = diskSummary(d, "m1").devices[0]!;
  if (dev.kind !== "nvme") throw new Error("kind");
  expect(dev.bytesWrittenInWindow).toBeNull();
  expect(dev.spanDays).toBeNull();
  expect(dev.ratedReachedAt).toBeNull();
});

test("readings older than 30 days are left out of the base", () => {
  const d = db();
  // Latest at T0+60 d. The reading at T0 is 60 d back: outside the window.
  // Base is the oldest inside it, T0+40 d (20 d back): Δ = 3e7 − 1e7 units = 2e7 × 512 000 B = 1.024e13 B over 20 d.
  recordReading(d, "m1", "nvme0", smart(1_000), T0);
  recordReading(d, "m1", "nvme0", smart(10_000_000), T0 + 40 * DAY);
  recordReading(d, "m1", "nvme0", smart(30_000_000), T0 + 60 * DAY);
  const dev = diskSummary(d, "m1").devices[0]!;
  if (dev.kind !== "nvme") throw new Error("kind");
  expect(dev.bytesWrittenInWindow).toBe(20_000_000 * 512_000);
  expect(dev.spanDays).toBe(20);
  // Only the old reading and the latest: nothing inside the window to compare with.
  const e = db();
  recordReading(e, "m1", "nvme0", smart(1_000), T0);
  recordReading(e, "m1", "nvme0", smart(30_000_000), T0 + 60 * DAY);
  const lone = diskSummary(e, "m1").devices[0]!;
  if (lone.kind !== "nvme") throw new Error("kind");
  expect(lone.bytesWrittenInWindow).toBeNull();
});

test("a device behind a controller comes back as such, with no projection", () => {
  const d = db();
  const raid = JSON.stringify({ smartctl: {}, device: { name: "/dev/sda", type: "megaraid,0", protocol: "SCSI" } });
  expect(recordReading(d, "m1", "sda", raid, T0)).toMatchObject({ ok: true, kind: "behind-controller" });
  const dev = diskSummary(d, "m1").devices[0]!;
  expect(dev.kind).toBe("behind-controller");
  expect(dev.ratedReachedAt).toBeNull();
  expect(dev.reading).toBeNull();
});

const count = (d: ReturnType<typeof db>, device = "nvme0"): number =>
  (d.query("SELECT COUNT(*) AS n FROM disk_reading WHERE device = ?").get(device) as { n: number }).n;

test("a write prunes the device's readings older than 60 days, keeping its newest two", () => {
  const d = db();
  // A reading a day for 100 days: the last write at T0+99 d keeps T0+39 d … T0+99 d (≥ T0+39 d), 61 rows.
  for (let i = 0; i < 100; i++) recordReading(d, "m1", "nvme0", smart(1_000 + i * 1_000), T0 + i * DAY);
  expect(count(d)).toBe(61);
  // The summary is unchanged by the prune: base T0+69 d, Δ = 30 × 1 000 units × 512 000 B over 30 d.
  const dev = diskSummary(d, "m1").devices[0]!;
  if (dev.kind !== "nvme") throw new Error("kind");
  expect(dev.bytesWrittenInWindow).toBe(30 * 1_000 * 512_000);
  expect(dev.spanDays).toBe(30);
  // A device read twice a year still keeps its newest two, so the alert has a previous reading.
  const e = db();
  recordReading(e, "m1", "nvme0", smart(1), T0);
  recordReading(e, "m1", "nvme0", smart(2), T0 + 200 * DAY);
  recordReading(e, "m1", "nvme0", smart(3), T0 + 400 * DAY);
  expect(count(e)).toBe(2);
  // Another device's old readings are not this write's to prune.
  recordReading(e, "m1", "nvme1", smart(1), T0);
  recordReading(e, "m1", "nvme0", smart(4), T0 + 600 * DAY);
  expect(count(e, "nvme1")).toBe(1);
});

test("a new machine past the cap, or a new device past the cap on one machine, is refused", () => {
  const d = db();
  for (let i = 0; i < MAX_MACHINES; i++) expect(recordReading(d, `m${i}`, "nvme0", smart(1), T0).ok).toBe(true);
  expect(recordReading(d, "one-more", "nvme0", smart(1), T0)).toEqual({ ok: false, reason: "too-many-machines" });
  for (let i = 1; i < MAX_DEVICES; i++) expect(recordReading(d, "m0", `nvme${i}`, smart(1), T0).ok).toBe(true);
  expect(recordReading(d, "m0", "one-more", smart(1), T0)).toEqual({ ok: false, reason: "too-many-devices" });
  // A known machine and device still file.
  expect(recordReading(d, "m0", "nvme0", smart(2), T0 + DAY).ok).toBe(true);
  expect((d.query("SELECT COUNT(*) AS n FROM disk_reading WHERE device = 'one-more'").get() as { n: number }).n).toBe(0);
});
