/**
 * Planned maintenance: an admin asks the forge to get ready for a power-off
 * (`prepare`), and on the next boot it comes back by itself (`resume`).
 *
 * prepare: hold releases (an owner hold, `keeper/hold.ts`), pause the crew
 * (the dispatcher starts nothing while the state file stands), take a fresh
 * snapshot, then report what still runs. The host may power off when
 * `status().ready` is true; a SIGTERM drains the rest as it does for a roll.
 * resume: lift the hold, let the crew start again, verify, and keep a line
 * saying what is healthy. No Kubernetes is asked anything.
 */

import { readFileSync } from "node:fs";
import type { App } from "../app.ts";
import { listApps } from "../core/apps.ts";
import { nightlyLines } from "../nightly/says.ts";
import { listActive } from "../core/runs.ts";
import type { User } from "../core/users.ts";
import { lift, MAX_REASON, setHold } from "../keeper/hold.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { running } from "../kernel/version.ts";
import { snapshotNow } from "../actions/backups_now.ts";
import { readState, writeState, type Maintenance, type Returned } from "./state.ts";

const isAdmin = (u: User | undefined): u is User => u?.isAdmin === true && u.kind !== "agent";

export interface Status {
  readonly phase: "idle" | "draining" | "ready";
  readonly since?: string;
  readonly reason?: string;
  readonly backup?: Maintenance["backup"];
  /** Crew runs and checks still queued or running. */
  readonly working: number;
  readonly last?: Returned;
  /** Plainly: what stops, or what is about to. */
  readonly says: string;
}

/** What stops when maintenance is prepared, one row each; the page and the terminal screen say it the same. */
export const ABOUT_TO_STOP_ROWS: readonly { readonly what: string; readonly stops: string }[] = [
  { what: "Releases", stops: "held now; none are cut." },
  { what: "The crew", stops: "no run starts; running ones finish." },
  { what: "The forge", stops: "stops with the host, with its apps and previews." },
];

/** The host's boot id, or undefined where the kernel does not say: it changes only when the host restarts. */
export function hostBootId(): string | undefined {
  try {
    const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return id === "" ? undefined : id;
  } catch {
    return undefined;
  }
}

export function status(app: App): Status {
  const { current, last } = readState(app.config.dataDir);
  if (current === undefined)
    return { phase: "idle", working: 0, ...(last ? { last } : {}), says: last ? last.says : "Not in maintenance." };
  const working = listActive(app.db, "agent").length + listActive(app.db, "check").filter((r) => r.state === "running").length;
  const ready = current.backup.ok && working === 0;
  return {
    phase: ready ? "ready" : "draining",
    since: current.since,
    reason: current.reason,
    backup: current.backup,
    working,
    says: ready
      ? "Ready: releases are held, the crew is paused, a fresh backup is taken and nothing is running. The host can power off."
      : !current.backup.ok
        ? `Not ready: ${current.backup.says}`
        : `Draining: ${working} crew run${working === 1 ? "" : "s"} or check${working === 1 ? "" : "s"} still going; the host can power off when it reads 0.`,
  };
}

export type Refusal = { readonly code: "not_found" | "invalid" | "conflict"; readonly says: string };

export async function prepare(app: App, actor: User | undefined, reasonIn: string): Promise<Result<Status, Refusal>> {
  if (!isAdmin(actor)) return err({ code: "not_found", says: "Only a forge admin prepares maintenance." });
  const reason = reasonIn.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (reason.length > 200) return err({ code: "invalid", says: "The reason is at most 200 characters." });
  const dataDir = app.config.dataDir;
  const prior = readState(dataDir);
  if (prior.current !== undefined) {
    // Asking again retakes the backup and reads the drain; the hold stands once.
    const taken = await snapshotNow(app, actor);
    writeState(dataDir, { ...prior, current: { ...prior.current, backup: { ok: taken.ok, says: taken.ok ? taken.value.says : taken.error.says } } });
    return ok(status(app));
  }
  const hold = setHold(app.db, {
    kind: "owner",
    version: running().version,
    reason: `maintenance${reason === "" ? "" : `: ${reason}`}`.slice(0, MAX_REASON),
    at: Date.now(),
  });
  const now = new Date().toISOString();
  // Written before the backup: the crew pauses at once, and a crash mid-backup still resumes at boot.
  const boot = hostBootId();
  const base: Maintenance = { since: now, by: actor.username, reason, holdId: hold.id, backup: { ok: false, says: "the backup has not finished" }, ...(boot === undefined ? {} : { bootId: boot }) };
  writeState(dataDir, { ...(prior.last ? { last: prior.last } : {}), current: base });
  app.bus.append({ kind: "maintenance.prepared", actorId: actor.id, payload: { hold: hold.id, reason } });
  const taken = await snapshotNow(app, actor);
  writeState(dataDir, {
    ...(prior.last ? { last: prior.last } : {}),
    current: { ...base, backup: { ok: taken.ok, says: taken.ok ? taken.value.says : taken.error.says } },
  });
  return ok(status(app));
}

/** Come back: lift our hold, start the crew, and record what was checked. `by` names who or what did it. */
export function resume(app: App, by: string): Result<Returned, Refusal> {
  const dataDir = app.config.dataDir;
  const { current } = readState(dataDir);
  if (current === undefined) return err({ code: "conflict", says: "The forge is not in maintenance." });
  const now = Date.now();
  const lifted = lift(app.db, current.holdId, by, now);
  const verified = [
    `database open, version ${running().version}`,
    lifted ? "release hold lifted" : "release hold was already lifted",
    "crew dispatcher unpaused",
    `${listApps(app.db).length} app(s) on record, started by the forge's own boot`,
    `nightly jobs: ${nightlyLines(app.config.dataDir).join(" / ")}`,
    `${listActive(app.db, "agent").length} crew run(s) and ${listActive(app.db, "check").length} check(s) waiting to start`,
  ];
  const back: Returned = {
    at: new Date(now).toISOString(),
    downSince: current.since,
    says: `Back at ${new Date(now).toISOString()} after maintenance begun ${current.since}: ${verified.join("; ")}.`,
    verified,
  };
  writeState(dataDir, { last: back });
  app.bus.append({ kind: "maintenance.ended", payload: { by, hold: current.holdId, verified } });
  return ok(back);
}

/**
 * At boot: a forge that went down prepared comes back by itself, once the host
 * has restarted. A restart of the process alone (a release roll) on the same
 * host boot keeps what the admin prepared. Where the boot id is unknown, resume:
 * a crew left paused is worse than a prepare that must be asked again.
 */
export function resumeAtBoot(app: App, bootId: string | undefined = hostBootId()): void {
  const { current } = readState(app.config.dataDir);
  if (current === undefined) return;
  if (bootId !== undefined && current.bootId === bootId) {
    app.log.info("maintenance stands: the process restarted, the host did not");
    return;
  }
  const r = resume(app, "boot");
  if (r.ok) app.log.info("maintenance ended at boot", { says: r.value.says });
}

export function resumeNow(app: App, actor: User | undefined): Result<Returned, Refusal> {
  if (!isAdmin(actor)) return err({ code: "not_found", says: "Only a forge admin ends maintenance." });
  return resume(app, actor.username);
}
