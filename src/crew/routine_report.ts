/**
 * What a Talk routine says (#11011): at most three plain lines, and whether
 * anything needs the person (only then does it reach their phone). `facts` reads
 * the forge; `compose` turns plain facts into lines and is where the words
 * and the rules live, so a test can hold them without a forge.
 */

import type { App } from "../app.ts";
import { forgeVitals } from "../actions/health.ts";
import { newAccountLines } from "../actions/accounts.ts";
import { redLines } from "./notify.ts";
import { askLinesFor } from "../web/studio/asks.ts";
import type { RoutineKind } from "../core/talk_routines.ts";
import type { User } from "../core/users.ts";
import { storyFacts, type Story } from "./routine_facts_story.ts";

export const LINES_MAX = 3;

export interface Facts extends Story {
  /** The forge's own words for what is wrong, empty when healthy. */
  readonly health: readonly string[];
  readonly redMain: readonly string[];
  /** What the person is asked to decide. */
  readonly asks: number;
  /** Crew member name to the runs it holds now. */
  readonly holds: Readonly<Record<string, number>>;
  readonly grokbotPulls: number;
  readonly mergedLastHour: number;
  readonly newPeople: readonly string[];
  /** Waiting account requests. */
  readonly waiting: number;
  readonly stuckRuns: number;
  /** Day-long figures for the paper. */
  readonly mergedToday: number;
  readonly openedToday: number;
}

export interface Report {
  readonly lines: readonly string[];
  /** True only when something needs the person: this is what pushes to the phone. */
  readonly needs: boolean;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** The one short clause for what shipped, or nothing when nothing moved. */
export function storyText(f: Story): string {
  const parts: string[] = [];
  if (f.releases.length > 0) {
    const shown = f.releases.slice(-3).join(", ");
    parts.push(`released ${f.releases.length > 3 ? `${f.releases.length} (to ${f.releases.at(-1)})` : shown}`);
  }
  if (f.pillarsMoved.length > 0) parts.push(`moved: ${f.pillarsMoved.slice(0, 3).map((p) => `${p.pillar} ${p.merged}`).join(", ")}`);
  return parts.join("; ");
}

const holdsText = (holds: Readonly<Record<string, number>>): string => {
  const names = Object.entries(holds).sort(([a], [b]) => a.localeCompare(b));
  return names.length === 0 ? "the crew holds nothing" : `crew: ${names.map(([n, c]) => `${n} ${c}`).join(", ")}`;
};

/** Pure: facts and a kind in, at most three lines and the need out. */
export function compose(kind: RoutineKind, f: Facts): Report {
  if (kind === "checkin") {
    const trouble = [...f.health, ...f.redMain];
    const lines = [
      trouble.length === 0 ? "Forge healthy, trunk green." : `Needs you: ${trouble.slice(0, 2).join("; ")}.`,
      `${plural(f.asks, "ask")} for you, ${plural(f.grokbotPulls, "grokbot pull")} open, ${plural(f.mergedLastHour, "merge")} in the last hour.`,
      `${holdsText(f.holds)}${f.stuckRuns > 0 ? `; ${plural(f.stuckRuns, "run")} stuck` : ""}${storyText(f) === "" ? "" : `; ${storyText(f)}`}.`,
    ];
    return { lines, needs: trouble.length > 0 || f.stuckRuns > 0 };
  }
  if (kind === "friends") {
    const lines: string[] = [];
    lines.push(f.newPeople.length === 0 ? "No new sign-ups." : `New: ${f.newPeople.slice(0, 5).join(", ")}${f.newPeople.length > 5 ? ` and ${f.newPeople.length - 5} more` : ""}.`);
    if (f.waiting > 0) lines.push(`${plural(f.waiting, "request")} for an account waiting for your allow.`);
    if (f.stuckRuns > 0) lines.push(`${plural(f.stuckRuns, "run")} stuck.`);
    return { lines: lines.slice(0, LINES_MAX), needs: f.waiting > 0 };
  }
  const lines = [
    f.health.length === 0 && f.redMain.length === 0 ? "Overnight the forge stayed healthy." : `Overnight: ${[...f.health, ...f.redMain].slice(0, 2).join("; ")}.`,
    `Today so far: ${plural(f.openedToday, "pull")} opened, ${plural(f.mergedToday, "merge")} landed; ${plural(f.asks, "ask")} wait for you.`,
    `${holdsText(f.holds)}.`,
  ];
  return { lines, needs: false };
}

const DAY = 86_400_000;

/** Read the forge as `user`; admins only, since the lines name other people's work. */
export async function facts(app: App, user: User, now: number, sinceMs = now - 3_600_000): Promise<Facts> {
  const db = app.db;
  const iso = (ms: number): string => new Date(ms).toISOString();
  const vitals = forgeVitals(app);
  const holds: Record<string, number> = {};
  for (const r of db
    .query<{ name: string; n: number }, []>(
      "SELECT u.username AS name, COUNT(*) AS n FROM run r JOIN user u ON u.id = r.actor_id WHERE r.kind = 'agent' AND r.state = 'running' AND u.kind = 'agent' GROUP BY u.username",
    )
    .all())
    holds[r.name] = r.n;
  const count = (sql: string, ...args: string[]): number => db.query<{ n: number }, string[]>(sql).get(...args)?.n ?? 0;
  const accounts = newAccountLines(db, user, now);
  const story = await storyFacts(app, sinceMs);
  return {
    ...story,
    health: vitals.ok ? [] : vitals.needs.slice(0, 3),
    redMain: redLines(app, user, now).map((l) => l.line),
    asks: askLinesFor(db, user).length,
    holds,
    grokbotPulls: count("SELECT COUNT(*) AS n FROM issue i JOIN user u ON u.id = i.author_id WHERE i.kind = 'pull' AND i.state = 'open' AND u.username = 'grokbot'"),
    mergedLastHour: count("SELECT COUNT(*) AS n FROM pull WHERE merged_at >= ?1", iso(now - 3_600_000)),
    newPeople: accounts.map((a) => a.line.split(" ")[0] ?? "").filter((n) => n !== ""),
    waiting: count("SELECT COUNT(*) AS n FROM account_request WHERE state = 'waiting'"),
    stuckRuns: vitals.stuck.length,
    mergedToday: count("SELECT COUNT(*) AS n FROM pull WHERE merged_at >= ?1", iso(now - DAY)),
    openedToday: count("SELECT COUNT(*) AS n FROM issue WHERE kind = 'pull' AND created_at >= ?1", iso(now - DAY)),
  };
}
