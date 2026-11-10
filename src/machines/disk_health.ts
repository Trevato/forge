/**
 * Disk health from `smartctl --json -a` (#10464): parse one reading, and
 * decide whether the drive itself reports something bad. Pure: text in, plain
 * data out.
 *
 * NVMe health log fields follow the NVMe base spec, "SMART / Health
 * Information" (Log Page 02h): a data unit is 1000 × 512 bytes; critical
 * warning is a bit field; temperature is composite, in °C (smartctl converts
 * from kelvin); warning/critical composite time are in minutes.
 *
 * Alerts only on what the drive says is bad (see `assessDisk`). Everything
 * else — unsafe shutdowns, temperature now, written vs rated — is a quiet
 * number for the page, never an alert.
 */

import type { DiskSpec } from "./disk_catalog.ts";

/** Bytes per NVMe "data unit": 1000 sectors of 512 bytes (NVMe base spec, log 02h). */
export const BYTES_PER_DATA_UNIT = 512_000;

const MAX_TEXT = 4_000_000;

export type DiskReading = {
  kind: "nvme";
  model: string;
  firmware: string;
  capacityBytes: number;
  dataUnitsWritten: number;
  bytesWritten: number;
  percentageUsed: number;
  availableSpare: number;
  spareThreshold: number;
  mediaErrors: number;
  criticalWarning: number;
  temperatureC: number;
  warnTempMinutes: number;
  critTempMinutes: number;
  powerOnHours: number;
  unsafeShutdowns: number;
};

export type BehindController = { kind: "behind-controller" };
export type Refusal = { kind: "refused"; reason: "not-json" | "not-smartctl-output" | "no-nvme-health-log" | "bad-field"; field?: string };
export type ParsedDisk = DiskReading | BehindController | Refusal;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** A non-negative safe integer, or undefined. */
function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

export function parseSmartJson(text: unknown): ParsedDisk {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_TEXT) return { kind: "refused", reason: "not-json" };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { kind: "refused", reason: "not-json" };
  }
  if (!isObj(doc) || !isObj(doc.smartctl) || !isObj(doc.device)) return { kind: "refused", reason: "not-smartctl-output" };

  const log = doc.nvme_smart_health_information_log;
  if (!isObj(log)) {
    const dev = doc.device as Obj;
    const ident = [dev.type, dev.protocol, doc.model_name, doc.product, doc.scsi_product, doc.scsi_vendor]
      .filter((x): x is string => typeof x === "string")
      .join(" ");
    if (/megaraid|perc|raid/i.test(ident)) return { kind: "behind-controller" };
    return { kind: "refused", reason: "no-nvme-health-log" };
  }

  const bad = (field: string): Refusal => ({ kind: "refused", reason: "bad-field", field });
  const model = doc.model_name;
  if (typeof model !== "string" || model.length === 0 || model.length > 200) return bad("model_name");
  const fw = doc.firmware_version;
  if (typeof fw !== "string" || fw.length > 100) return bad("firmware_version");
  const cap = isObj(doc.user_capacity) ? count(doc.user_capacity.bytes) : undefined;
  if (cap === undefined) return bad("user_capacity.bytes");

  const names = [
    "data_units_written",
    "percentage_used",
    "available_spare",
    "available_spare_threshold",
    "media_errors",
    "critical_warning",
    "temperature",
    "warning_temp_time",
    "critical_comp_time",
    "power_on_hours",
    "unsafe_shutdowns",
  ] as const;
  const n: Record<string, number> = {};
  for (const name of names) {
    const v = count(log[name]);
    if (v === undefined) return bad(name);
    n[name] = v;
  }

  return {
    kind: "nvme",
    model,
    firmware: fw,
    capacityBytes: cap,
    dataUnitsWritten: n.data_units_written!,
    bytesWritten: n.data_units_written! * BYTES_PER_DATA_UNIT,
    percentageUsed: n.percentage_used!,
    availableSpare: n.available_spare!,
    spareThreshold: n.available_spare_threshold!,
    mediaErrors: n.media_errors!,
    criticalWarning: n.critical_warning!,
    temperatureC: n.temperature!,
    warnTempMinutes: n.warning_temp_time!,
    critTempMinutes: n.critical_comp_time!,
    powerOnHours: n.power_on_hours!,
    unsafeShutdowns: n.unsafe_shutdowns!,
  };
}

export type Assessment = { level: "ok" | "alert"; reasons: string[] };

/** Percentage used at or above this is an alert (the drive's own wear estimate). */
export const WEAR_ALERT_PERCENT = 80;

/**
 * Alerts only on: a critical-warning bit set, available spare below its
 * threshold, percentage used ≥ 80, media errors higher than the previous
 * reading, minutes above the critical temperature higher than the previous
 * reading. `spec` (the vendor ratings, or null) is accepted so callers pass
 * one shape, but no rating raises an alert: written-vs-rated is a quiet number.
 */
export function assessDisk(reading: DiskReading, previous?: DiskReading | null, _spec?: DiskSpec | null): Assessment {
  const reasons: string[] = [];
  if (reading.criticalWarning !== 0) reasons.push(`critical warning bits set (0x${reading.criticalWarning.toString(16).padStart(2, "0")})`);
  if (reading.availableSpare < reading.spareThreshold) reasons.push(`available spare ${reading.availableSpare}% is below its threshold ${reading.spareThreshold}%`);
  if (reading.percentageUsed >= WEAR_ALERT_PERCENT) reasons.push(`percentage used ${reading.percentageUsed}% is at or above ${WEAR_ALERT_PERCENT}%`);
  if (previous && reading.mediaErrors > previous.mediaErrors) reasons.push(`media errors rose from ${previous.mediaErrors} to ${reading.mediaErrors}`);
  if (previous && reading.critTempMinutes > previous.critTempMinutes) reasons.push(`minutes above critical temperature rose from ${previous.critTempMinutes} to ${reading.critTempMinutes}`);
  return { level: reasons.length ? "alert" : "ok", reasons };
}
