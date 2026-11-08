/**
 * The model as a fallback for the data explorer's sentence box (#9569). The
 * rules in `parseSentence` answer first and cost nothing; only a sentence
 * they cannot read comes here. The model may answer only with the explorer's
 * own fields, and `validFill` checks every one against `SOURCES` before the
 * answer is used; `runQuery` then judges the query as it judges any link.
 * Plain data in, plain data out: the model itself is a function handed in.
 */
import type { App } from "../app.ts";
import { oneShot, type OneShotRefusal } from "../crew/one_shot.ts";
import { RateLimiter } from "../core/ratelimit.ts";
import type { Result } from "../kernel/result.ts";
import { CHARTS } from "./chart.ts";
import { GUIDE, parseSentence } from "./guide.ts";
import { isBucket, readParams } from "./params.ts";
import { SOURCES } from "./sources.ts";

const AGGREGATES = ["count", "sum", "avg", "max"];
const OPS = ["eq", "ne", "lt", "lte", "gt", "gte", "starts"];
const FIELDS = ["source", "aggregate", "column", "by", "series", "from", "to", "chart", "fcolumn", "fop", "fvalue"] as const;

/** Asks the model for text; replaced in tests. */
export type Ask = (app: App, userId: string, system: string, prompt: string) => Promise<Result<string, OneShotRefusal>>;
let ask: Ask = oneShot;
/** Swap the model, or put the real one back with no argument. */
export const useModel = (fn?: Ask): void => void (ask = fn ?? oneShot);

/** The brief: the sources and their columns, the fields allowed, and nothing else to say. */
export function brief(now: number): string {
  const sources = Object.entries(SOURCES).map(([name, s]) => `- ${name} (${GUIDE[name]?.name ?? name}): ${Object.entries(s.columns).map(([c, t]) => `${c}:${t}`).join(", ")}`);
  return [
    "You fill a form for a data explorer from one sentence. Answer with one JSON object and nothing else.",
    `Fields (all strings): ${FIELDS.join(", ")}.`,
    `aggregate is one of ${AGGREGATES.join(", ")}; count needs no column. by is minute, hour, day or a column of the source. chart is one of ${CHARTS.join(", ")}.`,
    `fop is one of ${OPS.join(", ")}. from and to are ISO 8601 times. Now is ${new Date(now).toISOString()}.`,
    "Use only these sources and their columns. If the sentence is not about them, answer {}.",
    ...sources,
  ].join("\n");
}

const isTime = (s: string) => /^\d{4}-\d\d-\d\d(T[\d:.]+Z?)?$/.test(s) && !Number.isNaN(Date.parse(s));

/** The model's answer as a fill, or null: every field known, every name a real source or column. */
export function validFill(raw: unknown): Record<string, string> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(FIELDS as readonly string[]).includes(k) || typeof v !== "string" || v.length > 120) return null;
    out[k] = v;
  }
  const source = out.source ?? "";
  if (!Object.hasOwn(SOURCES, source)) return null;
  const cols = SOURCES[source]!.columns;
  const col = (name: string | undefined) => name === undefined || name === "" || Object.hasOwn(cols, name);
  if (out.aggregate === undefined || !AGGREGATES.includes(out.aggregate)) return null;
  if (!col(out.column) || !col(out.series) || !col(out.fcolumn)) return null;
  if (out.aggregate !== "count" && (out.column ?? "") === "") return null;
  if (out.column && out.aggregate !== "count" && cols[out.column] !== "number") return null;
  if (out.by !== undefined && !isBucket(out.by) && !col(out.by)) return null;
  if (out.fop !== undefined && !OPS.includes(out.fop)) return null;
  if (out.chart !== undefined && !(CHARTS as readonly string[]).includes(out.chart)) return null;
  for (const t of [out.from, out.to]) if (t !== undefined && t !== "" && !isTime(t)) return null;
  if (out.fcolumn && cols[out.fcolumn] === "number" && Number.isNaN(Number(out.fvalue))) return null;
  // The same reading every link gets; a field it would bound or drop is not what was asked.
  const read = readParams(new URLSearchParams(out)) as Record<string, string>;
  for (const [k, v] of Object.entries(out)) if (read[k] !== v) return null;
  return out;
}

/** The JSON object in a model's reply, which may wrap it in a fence or a word. */
export function jsonIn(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export type Filled =
  | { ok: true; fill: Record<string, string>; by: "rules" | "model" }
  | { ok: false; why: "unread" | "off" | "limit" | "refused" };

/** Questions to the model one person may ask in a minute. */
export const MODEL_FILL_PER_MINUTE = 6;
const limiters = new WeakMap<App, RateLimiter>();
const allowed = (app: App, userId: string): boolean => {
  let l = limiters.get(app);
  if (l === undefined) limiters.set(app, (l = new RateLimiter({ perMinute: MODEL_FILL_PER_MINUTE, adminPerMinute: MODEL_FILL_PER_MINUTE, enabled: true })));
  return l.take(`explore-model:${userId}`, "rw").allowed;
};

/**
 * A sentence as the form it fills. The rules answer first, free; only a miss
 * asks the model, on the asker's own account and within its budget.
 */
export async function fillFromSentence(app: App, userId: string, text: string, now: number, mayAsk = true): Promise<Filled> {
  const rules = parseSentence(text, now);
  if (rules) return { ok: true, fill: rules, by: "rules" };
  if (text.trim() === "" || !mayAsk) return { ok: false, why: "unread" };
  if (!allowed(app, userId)) return { ok: false, why: "limit" };
  const said = await ask(app, userId, brief(now), `Sentence: ${JSON.stringify(text.slice(0, 200))}`);
  if (!said.ok) return { ok: false, why: said.error === "off" || said.error === "no_account" ? "off" : "unread" };
  const fill = validFill(jsonIn(said.value));
  if (fill === null || Object.keys(fill).length === 0) return { ok: false, why: "refused" };
  return { ok: true, fill, by: "model" };
}

/** What the explorer says when the model filled the form. */
export const MODEL_FILLED = "The model filled this form from your sentence. Check it before you trust it.";

const HINT = "Try a topic (cpu, memory, spend, deploys, slowest pages) and a window (last 3 days).";

/** What the explorer says when a sentence filled nothing; the web and the terminal both say it. */
export const unreadWords = (why: "unread" | "off" | "limit" | "refused"): string =>
  why === "limit" ? "The model is asked only a few times a minute; try again shortly." : why === "refused" ? `The model's answer was not a query this explorer can run. ${HINT}` : `I could not read that. ${HINT}`;
