/**
 * The Backups page's three buttons as actions: take a snapshot now, bring
 * the off-box mirror level now, and run a restore drill now. A forge
 * admin's only; anyone else is told `not_found`. Each answer carries
 * `says`, worded as the page's flash, so MCP `snapshot_now` / `mirror_now`
 * and the terminal say the same thing.
 * Nothing here ever names a key or a secret: only the store's name.
 */

import type { App } from "../app.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { DrillStep } from "../snapshot/drill.ts";
import { snapshotsOf } from "../snapshot/service.ts";
import { fileSize } from "../web/ui.ts";

const isAdmin = (actor: User | undefined): boolean => actor?.isAdmin === true;

export interface SnapshotTaken {
  readonly name: string;
  readonly repos: number;
  readonly apps: number;
  readonly bytes: number;
  readonly says: string;
}

export type SnapshotRefusal =
  | { readonly code: "not_found"; readonly says: string }
  | { readonly code: "no_store"; readonly says: string }
  | { readonly code: "failed"; readonly says: string };

/** Take a snapshot now; waits for any in flight. */
export async function snapshotNow(
  app: App,
  actor: User | undefined,
): Promise<Result<SnapshotTaken, SnapshotRefusal>> {
  if (!isAdmin(actor)) return err({ code: "not_found", says: "Only a forge admin takes a snapshot." });
  const svc = snapshotsOf(app);
  if (svc?.store === undefined)
    return err({ code: "no_store", says: "This forge has nowhere to put a snapshot." });
  try {
    const m = await svc.now();
    return ok({
      name: m.name,
      repos: m.repos,
      apps: m.apps,
      bytes: m.bytes,
      says: `Snapshot ${m.name} taken: ${m.repos} repositories, ${m.apps} apps, ${fileSize(m.bytes)}.`,
    });
  } catch (error) {
    return err({ code: "failed", says: `The snapshot failed: ${String(error)}` });
  }
}

export interface MirrorLevel {
  readonly level: boolean;
  readonly newest?: string;
  readonly error?: string;
  readonly says: string;
}

/** Bring the mirror level now; says in words whether it reached the mirror. */
export async function mirrorNow(
  app: App,
  actor: User | undefined,
): Promise<Result<MirrorLevel, { readonly code: "not_found"; readonly says: string }>> {
  if (!isAdmin(actor)) return err({ code: "not_found", says: "Only a forge admin brings the mirror level." });
  const state = await snapshotsOf(app)?.mirrorNow();
  if (state === undefined) return ok({ level: false, says: "This forge has no mirror to bring level." });
  if (state.sourceError !== undefined)
    return ok({
      level: false,
      error: state.sourceError,
      says: `The snapshots could not be read from the destination, so the mirror was not touched: ${state.sourceError}`,
    });
  if (state.failingSince === undefined)
    return ok({
      level: true,
      ...(state.newest ? { newest: state.newest } : {}),
      says: `The mirror is level${state.newest ? ` at ${state.newest}` : ""}.`,
    });
  return ok({
    level: false,
    ...(state.newest ? { newest: state.newest } : {}),
    error: state.error ?? "unknown reason",
    says: `The mirror is not level: ${state.error ?? "unknown reason"}`,
  });
}

export interface DrillRun {
  readonly verdict: "green" | "red";
  readonly failedStep: DrillStep | null;
  readonly says: string;
}

export type DrillRefusal =
  | { readonly code: "not_found"; readonly says: string }
  | { readonly code: "no_store"; readonly says: string }
  | { readonly code: "failed"; readonly says: string };

/** Run a restore drill now; waits for any in flight. A red drill is an answer, not a refusal. */
export async function drillNow(
  app: App,
  actor: User | undefined,
): Promise<Result<DrillRun, DrillRefusal>> {
  if (!isAdmin(actor)) return err({ code: "not_found", says: "Only a forge admin runs a restore drill." });
  const svc = snapshotsOf(app);
  if (svc?.store === undefined) return err({ code: "no_store", says: "This forge has no snapshots to drill." });
  try {
    const d = await svc.drill();
    return ok({
      verdict: d.verdict,
      failedStep: d.failedStep,
      says: d.verdict === "green" ? "The drill restored green." : `The drill failed at ${d.failedStep}.`,
    });
  } catch (error) {
    return err({ code: "failed", says: `The drill could not run: ${String(error)}` });
  }
}

/**
 * The newest snapshots first, one line each: `name · size`; empty when there
 * is no store. A store that cannot be listed is `unreadable`, never an empty
 * list: a broken store must not read as one with nothing kept.
 */
export async function recentSnapshots(
  app: App,
  actor: User | undefined,
  limit: number,
): Promise<Result<string[], "not_found" | "unreadable">> {
  if (!isAdmin(actor)) return err("not_found");
  try {
    const kept = (await snapshotsOf(app)?.list()) ?? [];
    return ok(kept.slice(0, limit).map((m) => `${m.name} · ${fileSize(m.bytes)}`));
  } catch {
    return err("unreadable");
  }
}
