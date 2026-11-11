/**
 * What a forge is told of its own plan (#11141): its plan's name and size,
 * its status and period end, and the host's public billing-portal address
 * (`billing.portal_url`) when it pays through Stripe. The host writes it into
 * that one child's own `plan.json` (not `parent.json`, which holds nothing of the parent's) when the forge is made and
 * whenever its entitlement changes; the child only ever reads its own file.
 * No call from a forge reaches the host for it, so a forge cannot learn
 * another's plan, and the notice carries no forge name, customer or
 * subscription id.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app.ts";
import { childDirOf, listChildrenNow } from "../actions/spawn.ts";
import { getPortalUrl, parseLink } from "../settings/billing.ts";
import { getPlan } from "../settings/plans.ts";
import { lapseFor } from "./lapse.ts";
import { entitlementOf, getStored } from "./store.ts";
import type { EntitlementStatus } from "./types.ts";

export interface PlanNotice {
  readonly name: string;
  readonly size: string;
  readonly priceUsd: number;
  readonly creditUsd: number;
  readonly status: EntitlementStatus;
  /** Unix seconds the paid period ends (and a past-due forge sleeps), when known. */
  readonly periodEnd?: number;
  /** The provider's customer-portal sign-in; absent without a provider or a URL. */
  readonly portalUrl?: string;
}

const file = (dataDir: string): string => join(dataDir, "plan.json");
const parentFile = (dataDir: string): string => join(dataDir, "parent.json");
const STATUSES: readonly string[] = ["active", "grace", "none"];

function readDoc(dataDir: string): Record<string, unknown> | undefined {
  try {
    const d = JSON.parse(readFileSync(file(dataDir), "utf8"));
    return typeof d === "object" && d !== null && !Array.isArray(d) ? (d as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const short = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max && !/[\x00-\x1f]/.test(v) ? v : undefined);
const money = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100_000 ? v : 0);

/** This forge's own notice, validated on read; undefined when it was told none. */
export function noticeOf(dataDir: string): PlanNotice | undefined {
  const r = readDoc(dataDir);
  if (r === undefined) return undefined;
  const name = short(r["name"], 60);
  const size = short(r["size"], 20);
  if (name === undefined || size === undefined || typeof r["status"] !== "string" || !STATUSES.includes(r["status"])) return undefined;
  const portal = typeof r["portalUrl"] === "string" ? parseLink(r["portalUrl"]) : undefined;
  return {
    name,
    size,
    priceUsd: money(r["priceUsd"]),
    creditUsd: money(r["creditUsd"]),
    status: r["status"] as EntitlementStatus,
    ...(typeof r["periodEnd"] === "number" && Number.isFinite(r["periodEnd"]) && r["periodEnd"] > 0 ? { periodEnd: r["periodEnd"] } : {}),
    ...(portal === undefined || portal === "" ? {} : { portalUrl: portal }),
  };
}

/** Write the notice into the child's own `plan.json`; false when the child has no `parent.json` yet. */
export function keepNotice(dataDir: string, notice: PlanNotice): boolean {
  if (!existsSync(parentFile(dataDir))) return false;
  writeFileSync(`${file(dataDir)}.tmp`, JSON.stringify(notice), { mode: 0o600 });
  renameSync(`${file(dataDir)}.tmp`, file(dataDir));
  return true;
}

/** Tell one forge its plan as the host holds it now. Never throws: a forge that cannot be reached is told at the next change. */
export function tellPlan(app: App, forge: string): boolean {
  try {
    const child = listChildrenNow(app).find((c) => c.name === forge && c.done);
    if (child === undefined) return false;
    const e = entitlementOf(app.db, forge, child.size);
    const plan = getPlan(app.db, e.plan);
    const portal = getPortalUrl(app.db);
    // In grace the forge is told the day it pauses (the end of grace), not the provider's period end.
    const lapse = e.status === "grace" ? lapseFor(app.db, forge) : undefined;
    const periodEnd = lapse?.state === "grace" ? Math.floor(lapse.graceUntil / 1000) : e.periodEnd;
    const paysAtProvider = getStored(app.db, forge)?.provider === "stripe";
    return keepNotice(childDirOf(app, child.bodyId), {
      name: plan?.name ?? e.plan,
      size: plan?.size ?? child.size,
      priceUsd: plan?.priceUsd ?? 0,
      creditUsd: plan?.creditUsd ?? 0,
      status: e.status,
      ...(periodEnd === undefined ? {} : { periodEnd }),
      ...(paysAtProvider && portal !== "" ? { portalUrl: portal } : {}),
    });
  } catch {
    return false;
  }
}

/** Tell every forge sent from here, after the portal address changes. */
export function tellAll(app: App): void {
  for (const c of listChildrenNow(app)) tellPlan(app, c.name);
}
