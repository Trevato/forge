/**
 * Disk readings kept per machine and device (#10465), in the forge's own
 * database. A reading is stored only after `parseSmartJson` accepts it.
 *
 * Write rate: the latest reading against the oldest one inside the 30 days
 * before it; bytes per day = Δbytes written ÷ Δdays (a rate over the span
 * actually covered, not a guess beyond it). Projected date: the latest time +
 * (rated TBW × 10^12 B − bytes written) ÷ rate. Ratings are vendor figures
 * (see disk_catalog.ts); the date is a projection, never an alert.
 */

import type { Database } from "bun:sqlite";
import { diskSpec, type DiskSpec } from "./disk_catalog.ts";
import { assessDisk, parseSmartJson, type Assessment, type DiskReading } from "./disk_health.ts";

const DAY_MS = 86_400_000;
export const WINDOW_DAYS = 30;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/;
/** A device keeps readings this many days back (twice the window), and always its newest two. */
export const KEEP_DAYS = 60;
const KEEP_NEWEST = 2;
/** At most this many machines per forge and devices per machine; a new name past either is refused. */
export const MAX_MACHINES = 256;
export const MAX_DEVICES = 64;
/** C0, DEL and C1 controls: any of them could steer the terminal that prints the text. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Text as a terminal may print it: every control character dropped. */
export const printable = (text: string): string => text.replace(new RegExp(CONTROL.source, "g"), "");

export type Inventory = { cpu: string; memoryBytes: number };
export type RecordResult =
  | { ok: true; kind: "nvme" | "behind-controller"; takenAt: number }
  | { ok: false; reason: string; field?: string };

/** Store a reading from smartctl's JSON text; a refusal names its reason and stores nothing. */
export function recordReading(
  db: Database,
  machine: string,
  device: string,
  smartJsonText: unknown,
  now: number = Date.now(),
  inventory?: Inventory,
): RecordResult {
  if (typeof machine !== "string" || !NAME.test(machine)) return { ok: false, reason: "bad-machine" };
  if (typeof device !== "string" || !NAME.test(device)) return { ok: false, reason: "bad-device" };
  if (!Number.isSafeInteger(now) || now < 0) return { ok: false, reason: "bad-time" };
  if (inventory !== undefined) {
    const okInv =
      typeof inventory.cpu === "string" && inventory.cpu.length > 0 && inventory.cpu.length <= 200 && !CONTROL.test(inventory.cpu) &&
      Number.isSafeInteger(inventory.memoryBytes) && inventory.memoryBytes > 0;
    if (!okInv) return { ok: false, reason: "bad-inventory" };
  }
  const parsed = parseSmartJson(smartJsonText);
  if (parsed.kind === "refused") return { ok: false, reason: parsed.reason, ...(parsed.field ? { field: parsed.field } : {}) };
  let refused: string | null = null;
  db.transaction(() => {
    const known = db.query("SELECT 1 FROM disk_reading WHERE machine = ? AND device = ? LIMIT 1").get(machine, device);
    if (!known) {
      const machineKnown = db.query("SELECT 1 FROM disk_reading WHERE machine = ? LIMIT 1").get(machine);
      if (!machineKnown) {
        const { n } = db.query("SELECT COUNT(DISTINCT machine) AS n FROM disk_reading").get() as { n: number };
        if (n >= MAX_MACHINES) return void (refused = "too-many-machines");
      } else {
        const { n } = db.query("SELECT COUNT(DISTINCT device) AS n FROM disk_reading WHERE machine = ?").get(machine) as { n: number };
        if (n >= MAX_DEVICES) return void (refused = "too-many-devices");
      }
    }
    db.query("INSERT INTO disk_reading (machine, device, taken_at, kind, reading) VALUES (?, ?, ?, ?, ?)").run(
      machine, device, now, parsed.kind, parsed.kind === "nvme" ? JSON.stringify(parsed) : null,
    );
    if (inventory)
      db.query(
        `INSERT INTO machine_inventory (machine, cpu, memory_bytes, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(machine) DO UPDATE SET cpu = excluded.cpu, memory_bytes = excluded.memory_bytes, updated_at = excluded.updated_at`,
      ).run(machine, inventory.cpu, inventory.memoryBytes, now);
    // Prune: the summary reads only the newest two and the oldest inside the window.
    db.query(
      `DELETE FROM disk_reading WHERE machine = ?1 AND device = ?2 AND taken_at < ?3
         AND id NOT IN (SELECT id FROM disk_reading WHERE machine = ?1 AND device = ?2 ORDER BY taken_at DESC, id DESC LIMIT ?4)`,
    ).run(machine, device, now - KEEP_DAYS * DAY_MS, KEEP_NEWEST);
  })();
  if (refused) return { ok: false, reason: refused };
  return { ok: true, kind: parsed.kind, takenAt: now };
}

export type DeviceSummary =
  | { device: string; kind: "behind-controller"; takenAt: number; reading: null; spec: null; assessment: null; bytesWrittenInWindow: null; ratedReachedAt: null }
  | {
      device: string;
      kind: "nvme";
      takenAt: number;
      reading: DiskReading;
      inventory: { model: string; firmware: string; capacityBytes: number };
      spec: DiskSpec | null;
      assessment: Assessment;
      /**
       * Bytes written between the oldest reading in the 30 days before the latest and the latest:
       * a 30-day figure only when spanDays is 30. Null with under two readings in the window.
       */
      bytesWrittenInWindow: number | null;
      /** Days that figure spans (≤ 30). */
      spanDays: number | null;
      /** ISO date (UTC) rated TBW is reached at that rate; null with no spec, under two readings, or no growth. */
      ratedReachedAt: string | null;
    };

export type MachineSummary = { machine: string; cpu: string | null; memoryBytes: number | null; devices: DeviceSummary[] };

type Row = { id: number; taken_at: number; kind: string; reading: string | null };
const COLS = "id, taken_at, kind, reading";

export function diskSummary(db: Database, machine: string): MachineSummary {
  const inv = db.query("SELECT cpu, memory_bytes FROM machine_inventory WHERE machine = ?").get(machine) as
    | { cpu: string; memory_bytes: number }
    | null;
  const devices = (db.query("SELECT DISTINCT device FROM disk_reading WHERE machine = ? ORDER BY device").all(machine) as { device: string }[]).map(
    (d) => d.device,
  );
  const out: DeviceSummary[] = [];
  for (const device of devices) {
    // Three bounded reads on (machine, device, taken_at): the latest row, the
    // newest two NVMe readings, and the oldest NVMe reading inside the window.
    const latest = db
      .query(`SELECT ${COLS} FROM disk_reading WHERE machine = ? AND device = ? ORDER BY taken_at DESC, id DESC LIMIT 1`)
      .get(machine, device) as Row;
    if (latest.kind !== "nvme" || latest.reading === null) {
      out.push({ device, kind: "behind-controller", takenAt: latest.taken_at, reading: null, spec: null, assessment: null, bytesWrittenInWindow: null, ratedReachedAt: null });
      continue;
    }
    const nvme = db
      .query(
        `SELECT ${COLS} FROM disk_reading WHERE machine = ? AND device = ? AND kind = 'nvme' AND reading IS NOT NULL
         ORDER BY taken_at DESC, id DESC LIMIT 2`,
      )
      .all(machine, device) as Row[];
    const reading = JSON.parse(nvme[0]!.reading!) as DiskReading;
    const previous = nvme[1] ? (JSON.parse(nvme[1].reading!) as DiskReading) : null;
    const spec = diskSpec(reading.model);

    const windowStart = latest.taken_at - WINDOW_DAYS * DAY_MS;
    const base = db
      .query(
        `SELECT ${COLS} FROM disk_reading WHERE machine = ? AND device = ? AND kind = 'nvme' AND reading IS NOT NULL
         AND taken_at >= ? AND id != ? ORDER BY taken_at ASC, id ASC LIMIT 1`,
      )
      .get(machine, device, windowStart, nvme[0]!.id) as Row | null;
    let bytes30: number | null = null;
    let spanDays: number | null = null;
    let reached: string | null = null;
    if (base && base.taken_at < latest.taken_at) {
      const baseReading = JSON.parse(base.reading!) as DiskReading;
      const delta = reading.bytesWritten - baseReading.bytesWritten;
      if (delta >= 0) {
        bytes30 = delta;
        spanDays = (latest.taken_at - base.taken_at) / DAY_MS;
        if (spec) {
          const remaining = spec.ratedTbw * 1e12 - reading.bytesWritten;
          if (remaining <= 0) reached = new Date(latest.taken_at).toISOString().slice(0, 10);
          else if (delta > 0) {
            const perDay = delta / spanDays;
            const at = new Date(latest.taken_at + (remaining / perDay) * DAY_MS);
            // A rate so small the date leaves the calendar is no projection.
            if (at.getUTCFullYear() <= 9999) reached = at.toISOString().slice(0, 10);
          }
        }
      }
    }
    out.push({
      device,
      kind: "nvme",
      takenAt: latest.taken_at,
      reading,
      inventory: { model: reading.model, firmware: reading.firmware, capacityBytes: reading.capacityBytes },
      spec,
      assessment: assessDisk(reading, previous, spec),
      bytesWrittenInWindow: bytes30,
      spanDays,
      ratedReachedAt: reached,
    });
  }
  return { machine, cpu: inv?.cpu ?? null, memoryBytes: inv?.memory_bytes ?? null, devices: out };
}

/** Machine names that have a reading or an inventory, A to Z. */
export function machineNames(db: Database): string[] {
  return (
    db.query("SELECT machine FROM disk_reading UNION SELECT machine FROM machine_inventory ORDER BY machine").all() as { machine: string }[]
  ).map((r) => r.machine);
}
