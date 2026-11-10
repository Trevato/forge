/**
 * Who writes and who reads a machine's disk readings (#10465). Both are the
 * owner — a forge admin who is a person: a reading is a claim about hardware
 * that decides what the owner replaces, so an agent account neither files nor
 * reads one. Anyone else gets "not_found" here; over the API a signed-in
 * non-admin meets the admin gate's 403 first (`http/admin_gate.ts`).
 */
import type { App } from "../app.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { diskSummary, machineNames, recordReading, type Inventory, type MachineSummary } from "../machines/disk_readings.ts";

export const mayHandleDisks = (user: User | undefined): user is User => user !== undefined && user.isAdmin && user.kind !== "agent";

export type FileError = { code: "not_found" } | { code: "invalid"; says: string };

/** Store one reading from smartctl's JSON text for `machine` and `device`. */
export function fileReading(
  app: App,
  actor: User | undefined,
  machine: string,
  device: string,
  smartJsonText: unknown,
  inventory?: Inventory,
): Result<{ kind: "nvme" | "behind-controller"; takenAt: number }, FileError> {
  if (!mayHandleDisks(actor)) return err({ code: "not_found" });
  const r = recordReading(app.db, machine, device, smartJsonText, Date.now(), inventory);
  if (!r.ok) return err({ code: "invalid", says: `Reading refused: ${r.reason}${r.field ? ` (${r.field})` : ""}.` });
  return ok({ kind: r.kind, takenAt: r.takenAt });
}

/** What the readings of one machine say; nothing for anyone but the owner. */
export function readMachine(app: App, actor: User | undefined, machine: string): Result<MachineSummary, "not_found"> {
  if (!mayHandleDisks(actor)) return err("not_found");
  return ok(diskSummary(app.db, machine));
}

/** The machines with readings; nothing for anyone but the owner. */
export function readMachines(app: App, actor: User | undefined): Result<string[], "not_found"> {
  return mayHandleDisks(actor) ? ok(machineNames(app.db)) : err("not_found");
}
