/**
 * The Plan row in a forge's settings (#11141), one `dl` row for its admins: the
 * plan's name and size, the crew credit used this month, and the status (past
 * due says the date it sleeps). Everything is what the host told this forge
 * (`billing/notice.ts`) and its own funding file; nothing is asked of the
 * host. "Manage billing" is the provider's portal sign-in, shown only when
 * the host set one and this forge pays through it; "Change size" is the
 * host's /pricing.
 */

import { noticeOf, type PlanNotice } from "../billing/notice.ts";
import { fundingOf } from "../spawn/funding.ts";
import { usdWords } from "../spawn/credit.ts";
import { sizeWords } from "../settings/billing.ts";
import { isSize } from "../spawn/sizes.ts";
import { html, type Html } from "./html.ts";

const day = (secs: number): string => new Date(secs * 1000).toISOString().slice(0, 10);

/** "Active", or "Past due, sleeps 2026-12-01". */
export function statusWords(n: Pick<PlanNotice, "status" | "periodEnd">): string {
  if (n.status === "grace") return n.periodEnd === undefined ? "Past due" : `Past due, sleeps ${day(n.periodEnd)}`;
  return n.status === "none" ? "No active plan" : "Active";
}

/** The plan as one plain line of text, or undefined when this forge was told none; the page and the terminal say the same. */
export function planLine(dataDir: string): string | undefined {
  const n = noticeOf(dataDir);
  if (n === undefined) return undefined;
  const f = fundingOf(dataDir);
  const size = isSize(n.size) ? ` (${sizeWords(n.size)})` : "";
  const credit = n.creditUsd > 0 && f?.spentUsd != null ? ` ${usdWords(f.spentUsd)} of ${usdWords(n.creditUsd)} crew credit used this month.` : "";
  return `${n.name}${size}. ${statusWords(n)}.${credit}`;
}

/** One `dl` row for a forge's admins; null for anyone else or a forge told nothing. */
export function planRow(dataDir: string, parentOrigin: string | undefined, admin: boolean): Html | null {
  if (!admin) return null;
  const line = planLine(dataDir);
  if (line === undefined) return null;
  const portal = noticeOf(dataDir)?.portalUrl;
  return html`<dl class="status-rows"><div class="status-row"><dt>Plan</dt><dd>${line}${
    portal === undefined ? "" : html` <a href="${portal}" rel="noopener noreferrer" target="_blank">Manage billing</a>`
  }${parentOrigin === undefined ? "" : html` <a href="${parentOrigin}/pricing">Change size</a>`}</dd></div></dl>`;
}
