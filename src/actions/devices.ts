/**
 * Declaring, removing and reading devices, for the page and the terminal
 * alike: one gate (a forge admin), one set of refusals in words, and the same
 * `device.*` events, so a write from either door reaches viewers of the other.
 */

import type { App } from "../app.ts";
import {
  declareDevice,
  isFresh,
  keepProbe,
  listDevices,
  removeDevice,
  type Device,
  type DeviceError,
} from "../core/devices.ts";
import type { User } from "../core/users.ts";
import { probePrinter, type PrinterReport } from "../devices/ipp.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type DeviceActionError = DeviceError | "forbidden";

export const DEVICE_ERRORS: Record<DeviceActionError, string> = {
  invalid_name: "A name is letters, digits, spaces, dots, dashes or underscores, up to 60.",
  invalid_kind: "Only printers can be declared for now.",
  invalid_url: "That is not an IPP address. Try ipp://192.168.1.161:631/ipp/print.",
  public_address: "The address must be a number on your own network (like 192.168.1.161). The forge does not ask public hosts or look up names.",
  name_taken: "A device already has that name.",
  not_found: "No such device.",
  forbidden: "Only a site admin manages devices.",
};

export const mayManageDevices = (actor: User | undefined): actor is User =>
  actor !== undefined && actor.isAdmin && actor.kind === "user";

export function declare(
  app: App,
  actor: User | undefined,
  input: { name: string; kind: string; url: string },
): Result<Device, DeviceActionError> {
  if (!mayManageDevices(actor)) return err("forbidden");
  const made = declareDevice(app.db, input);
  if (!made.ok) return made;
  app.bus.append({
    kind: "device.declared",
    actorId: actor.id,
    payload: { name: made.value.name, kind: made.value.kind },
  });
  return ok(made.value);
}

export function remove(app: App, actor: User | undefined, id: number): Result<true, DeviceActionError> {
  if (!mayManageDevices(actor)) return err("forbidden");
  if (!Number.isSafeInteger(id)) return err("not_found");
  const gone = removeDevice(app.db, id);
  if (!gone.ok) return gone;
  app.bus.append({ kind: "device.removed", actorId: actor.id, payload: { id } });
  return gone;
}

/** The devices, each stale printer asked at once within the probe's own bound; a fresh one is not asked. */
export async function devicesWithStatus(app: App): Promise<Device[]> {
  return Promise.all(
    listDevices(app.db).map(async (d) => {
      if (isFresh(d)) return d;
      const result = await probePrinter(d.url);
      const report = result.ok ? result.report : null;
      keepProbe(app.db, d.id, report);
      return { ...d, probe: report, probedAt: new Date().toISOString() };
    }),
  );
}

const STATE_WORDS = { idle: "Ready", printing: "Printing", stopped: "Stopped", unknown: "State unknown" } as const;

/** What the printer said, as the one line a person needs. */
export function statusLine(report: PrinterReport | null): string {
  if (report === null) return "Not reachable right now.";
  const low = report.supplies.filter((s) => s.percent !== null && s.percent <= 10);
  const bits = [report.model, STATE_WORDS[report.state]];
  if (low.length > 0) bits.push(`low: ${low.map((s) => s.name).join(", ")}`);
  else if (report.supplies.length > 0) bits.push("supplies fine");
  return bits.filter((b) => b !== "").join(" · ");
}
