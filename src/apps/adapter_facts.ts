/**
 * What an app's adapter looks like from outside (#10037): its declared spec,
 * its last pull and the cursor of the last good one. The web page
 * (`web/studio/adapter.ts`) and the terminal screen (`tui/screens/adapter.ts`)
 * both read these facts, so the two doors cannot disagree. Owner facts: the
 * callers gate with `canSeeOwnerFacts`.
 *
 * `declaredAdapter` reads git, but only to resolve the default branch's tip;
 * the parsed spec is cached by tip, so a page view costs one ref lookup.
 */
import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import type { AppRecord } from "../core/apps.ts";
import { lastPullCursor, listPullRuns, type PullRun } from "../core/runs.ts";
import { pullRunLines, type PullRunLine } from "./pull.ts";
import type { AdapterSpec } from "./adapter.ts";
import { declaredAdapter } from "./pull_schedule.ts";

/** The facts: pure data, so a test renders them without a database. */
export interface AdapterFacts {
  readonly spec: AdapterSpec;
  readonly last: PullRun | undefined;
  readonly cursor: string | undefined;
  /** The last `PULL_RUNS_SHOWN` runs, newest first; absent reads as none. */
  readonly runs?: readonly PullRunLine[];
}

/** How many runs the page and the terminal list. */
export const PULL_RUNS_SHOWN = 10;
export const NO_RUNS_WORDS = "No pull runs yet.";

/** The runs both doors list: one indexed read, newest first, at most `PULL_RUNS_SHOWN`. */
export function shownRuns(db: Database, appId: string): PullRunLine[] {
  return pullRunLines(db, appId, PULL_RUNS_SHOWN);
}

/** One run's wording after its time and state: the counts, then the error sentence of a failed run. */
export function pullRunWords(r: PullRunLine): string {
  const counts = `${r.written} written, ${r.skipped} skipped, ${r.failed} failed`;
  return r.error === null || r.error === "" ? counts : `${counts} · ${r.error}`;
}

/** The runs as plain [when, words] rows for the terminal, under the facts. */
export function adapterRunRows(facts: AdapterFacts): Array<[string, string]> {
  return (facts.runs ?? []).map((r) => [r.at, `${r.state} ${pullRunWords(r)}`]);
}

/** Seconds as a phrase: `15 minutes`, `1 hour`. */
export function everyWords(seconds: number): string {
  const unit = seconds % 3600 === 0 ? ["hour", 3600] : seconds % 60 === 0 ? ["minute", 60] : ["second", 1];
  const n = seconds / (unit[1] as number);
  return `${n} ${unit[0]}${n === 1 ? "" : "s"}`;
}

/** The facts for an app that declares an adapter on its default branch; undefined for any other. */
export async function adapterFactsOf(app: App, record: AppRecord): Promise<AdapterFacts | undefined> {
  const spec = await declaredAdapter(app, record);
  if (spec === undefined) return undefined;
  return { spec, last: listPullRuns(app.db, record.id, 1)[0], cursor: lastPullCursor(app.db, record.id), runs: shownRuns(app.db, record.id) };
}

/** When the next pull is due, in epoch ms; undefined before the first pull or when the stamp is unreadable. */
export function nextDue(facts: AdapterFacts): number | undefined {
  if (facts.last === undefined) return undefined;
  const due = Date.parse(facts.last.createdAt) + facts.spec.schedule.every * 1000;
  return Number.isFinite(due) ? due : undefined;
}

/**
 * One piece of a fact's wording. The words live here, once; a door only
 * chooses how each kind looks: the web turns `badge` into a badge, `time` into
 * a `<time>`, `muted` into muted text and `code` into `<code>`; the terminal
 * prints them all as plain text.
 */
export type FactPart =
  | { readonly kind: "text" | "muted" | "badge" | "code"; readonly text: string }
  | { readonly kind: "time"; readonly iso: string };

export interface FactRow {
  readonly label: string;
  readonly parts: readonly FactPart[];
}

const text = (t: string): FactPart => ({ kind: "text", text: t });
const muted = (t: string): FactPart => ({ kind: "muted", text: t });

function lastPullParts(last: AdapterFacts["last"]): FactPart[] {
  if (last === undefined) return [muted("Not yet")];
  if (last.state !== "ok")
    return [{ kind: "badge", text: "failed" }, text(` ${last.reason} · `), { kind: "time", iso: last.createdAt }];
  return [
    { kind: "badge", text: "ok" },
    text(` ${last.written} written, ${last.skipped} skipped, ${last.failed} failed · `),
    { kind: "time", iso: last.createdAt },
    ...(last.repeat ? [text(" · nothing new")] : []),
  ];
}

function nextPullParts(facts: AdapterFacts, now: number): FactPart[] {
  if (facts.last === undefined) return [muted("On the next sweep, once it is running")];
  const due = nextDue(facts);
  if (due === undefined) return [];
  if (due <= now) return [muted("Due now, once it is running")];
  return [
    { kind: "time", iso: new Date(due).toISOString() },
    text(" "),
    muted(`(in ${everyWords(Math.ceil((due - now) / 1000))})`),
  ];
}

/** The facts as labelled rows of wording: the one source both doors render. */
export function adapterFactRows(facts: AdapterFacts, now: number = Date.now()): FactRow[] {
  const { spec, cursor } = facts;
  return [
    { label: "Source", parts: [text(spec.source?.name ?? "Not named")] },
    { label: "Every", parts: [text(everyWords(spec.schedule.every))] },
    { label: "Last pull", parts: lastPullParts(facts.last) },
    { label: "Next pull", parts: nextPullParts(facts, now) },
    { label: "Cursor", parts: [cursor === undefined || cursor === "" ? muted("None yet") : { kind: "code", text: cursor }] },
  ];
}

/** The facts as plain label/value rows, for the terminal. */
export function adapterRows(facts: AdapterFacts, now: number = Date.now()): Array<[string, string]> {
  return adapterFactRows(facts, now).map((row) => [
    row.label,
    row.parts.map((p) => (p.kind === "time" ? p.iso : p.text)).join(""),
  ]);
}
