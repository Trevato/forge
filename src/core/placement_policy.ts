/**
 * The placement policy (#509, docs/PROFIT.md): where an environment should
 * run — on owned metal or in a cloud — from how full owned metal is and the
 * profit slider's spill threshold (`policyAt(position).spillAtOwnedUse`).
 * Owned metal is paid for either way, so it runs full; cloud takes bursts.
 *
 * - With no cloud body configured every answer is `owned`, and the reason
 *   says a burst queues — never silently.
 * - Production and an `always_on` app stay owned until owned is full.
 * - A preview spills first: once owned use reaches the threshold.
 * - An app's `placement: metal|cloud` preference is honoured, unless it
 *   asks for metal and owned is full.
 *
 * Plain data in, plain data out: nothing here reads the database or acts.
 * Where the body actually runs is the spawn seam's (`spawn/placement.ts`).
 */

import type { Placement } from "./meter.ts";

export type { Placement };

/** What an app's manifest asks for (`app.placement`, `apps/service.ts`). */
export type PlacementPreference = "metal" | "cloud" | null;

export interface PlacementInput {
  /** Environments owned metal holds now, this one not counted. */
  readonly ownedUsed: number;
  /** Environments owned metal can hold; `Infinity` when no limit is known. */
  readonly ownedCapacity: number;
  /** Share of owned capacity (0–1) at or above which a preview spills. */
  readonly spillAtOwnedUse: number;
  /** Production, or an `always_on` app: stays owned until owned is full. */
  readonly alwaysOn: boolean;
  readonly preference: PlacementPreference;
  /** Whether a cloud body is configured to take a burst. */
  readonly cloudBody: boolean;
}

export interface PlacementDecision {
  readonly where: Placement;
  /** One sentence a person reads on the ledger and the board. */
  readonly reason: string;
}

/** The words the board shows when there is nowhere to spill to. */
export const NO_CLOUD_BODY = "no cloud body: bursts queue";

function percent(share: number): string {
  return `${Math.round(share * 1000) / 10}%`;
}

export function placeFor(input: PlacementInput): PlacementDecision {
  const capacity = Number.isFinite(input.ownedCapacity) ? Math.max(0, input.ownedCapacity) : Infinity;
  const used = Math.max(0, input.ownedUsed);
  const full = used >= capacity;
  const share = capacity === Infinity ? 0 : capacity === 0 ? 1 : used / capacity;
  const use = capacity === Infinity ? "owned metal has room" : `owned metal is at ${percent(share)}`;

  if (!input.cloudBody) {
    return {
      where: "owned",
      reason: full ? `Owned metal is full and there is ${NO_CLOUD_BODY}.` : `Runs on owned metal; ${NO_CLOUD_BODY}.`,
    };
  }
  if (input.preference === "cloud") return { where: "cloud", reason: "The app asks for cloud." };
  if (full) return { where: "cloud", reason: "Owned metal is full, so this spills to cloud." };
  if (input.preference === "metal") return { where: "owned", reason: `The app asks for metal and ${use}.` };
  if (input.alwaysOn) return { where: "owned", reason: `Production stays on owned metal until it is full; ${use}.` };
  if (share >= input.spillAtOwnedUse) {
    return {
      where: "cloud",
      reason: `A preview spills first: ${use}, at or above the ${percent(input.spillAtOwnedUse)} threshold.`,
    };
  }
  return { where: "owned", reason: `${use[0]!.toUpperCase()}${use.slice(1)}, below the ${percent(input.spillAtOwnedUse)} threshold.` };
}

/** The owned-node label a forge boots with until an admin sets another. */
export const OWNED_NODE_LABEL_DEFAULT = "plat.sh/site=vxrail";

const LABEL_NAME = /^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
const LABEL_PREFIX = /^(?=.{1,253}$)[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?)*$/;

/**
 * A Kubernetes node label as `key=value` (`plat.sh/site=vxrail`), trimmed;
 * undefined for anything else. The key may carry a DNS prefix; the value may
 * be empty, as a label's may.
 */
export function parseNodeLabel(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const label = input.trim();
  if (label.length > 400) return undefined;
  const eq = label.indexOf("=");
  if (eq < 0) return undefined;
  const key = label.slice(0, eq);
  const value = label.slice(eq + 1);
  const slash = key.indexOf("/");
  const prefix = slash < 0 ? undefined : key.slice(0, slash);
  const name = slash < 0 ? key : key.slice(slash + 1);
  if (prefix !== undefined && !LABEL_PREFIX.test(prefix)) return undefined;
  if (!LABEL_NAME.test(name)) return undefined;
  if (value !== "" && !LABEL_NAME.test(value)) return undefined;
  return label;
}

/**
 * What a person typed for the owned-node label, at any door: blank is the
 * default again, a label is itself, anything else is undefined (refused).
 */
export function labelInput(input: unknown): string | undefined {
  if (typeof input === "string" && input.trim() === "") return OWNED_NODE_LABEL_DEFAULT;
  return parseNodeLabel(input);
}
