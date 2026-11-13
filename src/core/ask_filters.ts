/**
 * The filters an owner sets on what asks them (#11820): hide an app (for a
 * day, or until shown again) and hide a kind of decision. Saved per person in
 * the forge's database, read by the web, the MCP and the terminal through
 * these functions alone. A filter only decides whether an ask shows: the ask
 * is never changed, declined or lost, and it returns when the day ends or the
 * owner taps "Show all". A trust alarm (security) is never hidden by one.
 * Pure data: the route owes the validation of what it passes in.
 */

import type { Database } from "bun:sqlite";

/** Every kind of decision that can ask a person. */
export const ASK_KINDS = [
  "stopped", "look", "review", "paused", "parked", "declined", "handover", "waiting", "assigned", "proposal",
] as const;
export type AskKind = (typeof ASK_KINDS)[number];

export const isAskKind = (v: unknown): v is AskKind =>
  typeof v === "string" && (ASK_KINDS as readonly string[]).includes(v);

/** The score a security ask carries: the top of the order, and exempt from every filter. */
export const TRUST_ALARM_SCORE = 100;

/** Whether an ask is a trust alarm: no filter hides it. */
export const isTrustAlarm = (c: { readonly score: number }): boolean => c.score >= TRUST_ALARM_SCORE;

/** How long "hide for a day" hides. */
export const HIDE_DAY_MS = 24 * 60 * 60 * 1000;

/** What is hidden right now: app (repository) ids and decision kinds. */
export interface AskFilters {
  readonly apps: ReadonlySet<string>;
  readonly kinds: ReadonlySet<AskKind>;
}

export const noAskFilters: AskFilters = { apps: new Set(), kinds: new Set() };

/** The words every surface uses for the line and the one tap that clears it. */
export const hiddenLine = (n: number): string => `${n} hidden by your filters`;
export const SHOW_ALL_WORDS = "Show all";
export const HIDE_APP_DAY_WORDS = "Hide app for a day"
export const HIDE_KIND_WORDS = "Hide kind";

/** The filters in force at `now`: a "for a day" hide that has ended is not one. */
export function askFiltersOf(db: Database, viewerId: string, now = Date.now()): AskFilters {
  const apps = new Set<string>();
  const kinds = new Set<AskKind>();
  for (const r of db
    .query<{ kind: string; value: string; until: string | null }, [string]>(
      "SELECT kind, value, until FROM ask_filter WHERE viewer_id = ?1",
    )
    .all(viewerId)) {
    if (r.until !== null && Date.parse(r.until) <= now) continue;
    if (r.kind === "app") apps.add(r.value);
    else if (isAskKind(r.value)) kinds.add(r.value);
  }
  return { apps, kinds };
}

export const hasAskFilters = (f: AskFilters): boolean => f.apps.size > 0 || f.kinds.size > 0;

/** Hide one app: for a day from `now`, or until it is shown again. Twice renews it. */
export function hideApp(db: Database, viewerId: string, repoId: string, forADay: boolean, now = Date.now()): void {
  db.query(
    "INSERT OR REPLACE INTO ask_filter (viewer_id, kind, value, until) VALUES (?1, 'app', ?2, ?3)",
  ).run(viewerId, repoId, forADay ? new Date(now + HIDE_DAY_MS).toISOString() : null);
}

/** Hide one kind of decision until it is shown again. */
export function hideKind(db: Database, viewerId: string, kind: AskKind): void {
  db.query(
    "INSERT OR REPLACE INTO ask_filter (viewer_id, kind, value, until) VALUES (?1, 'kind', ?2, NULL)",
  ).run(viewerId, kind);
}

/** Show one app or kind again; not hidden is the same as shown. */
export function showAgain(db: Database, viewerId: string, what: { kind: "app" | "kind"; value: string }): void {
  db.query("DELETE FROM ask_filter WHERE viewer_id = ?1 AND kind = ?2 AND value = ?3").run(
    viewerId,
    what.kind,
    what.value,
  );
}

/** A deleted app's filters go with it: the app value has no foreign key to cascade. */
export function forgetAppFilters(db: Database, repoId: string): void {
  db.query("DELETE FROM ask_filter WHERE kind = 'app' AND value = ?1").run(repoId);
}

/** The one tap: every filter of this person off. */
export function clearAskFilters(db: Database, viewerId: string): void {
  db.query("DELETE FROM ask_filter WHERE viewer_id = ?1").run(viewerId);
}

/** Whether the filters hide an ask of this kind in this app; a trust alarm is never hidden. */
export function filterHides(
  f: AskFilters,
  ask: { readonly kind: AskKind; readonly repoId: string; readonly consequence: { readonly score: number } },
): boolean {
  if (isTrustAlarm(ask.consequence)) return false;
  return f.apps.has(ask.repoId) || f.kinds.has(ask.kind);
}
