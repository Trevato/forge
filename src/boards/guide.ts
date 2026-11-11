/**
 * The plain words for the data explorer: what each source is called, what a
 * row of it counts, which chart it opens on, the ready questions to start
 * from, and the sentence that says what a chart shows. Plain data in, plain
 * data out: the page reads it, nothing here touches the database.
 */
import { SOURCES } from "./sources.ts";

export type Guide = {
  /** What people call it. */
  name: string;
  /** What a row is, plural: what `count` counts. */
  rows: string;
  /** "samples": a reading taken on a clock, so a count means nothing; "events": things that happened. */
  kind: "samples" | "events";
  /** The number column a samples source is averaged over by default. */
  value?: string;
  /** Fixed filter the default chart carries. */
  filter?: { column: string; op: string; value: string };
};

export const GUIDE: Readonly<Record<string, Guide>> = {
  runs: { name: "Crew and build runs", rows: "runs", kind: "events" },
  pulls: { name: "Merged pulls", rows: "merged pulls", kind: "events" },
  reviews: { name: "Reviews", rows: "reviews", kind: "events" },
  deploys: { name: "Deploys", rows: "deploys", kind: "events" },
  apps: { name: "Apps", rows: "apps created", kind: "events" },
  wakes: { name: "App wake-ups", rows: "wake-ups", kind: "events" },
  sleeps: { name: "App sleeps", rows: "sleeps", kind: "events" },
  decisions: { name: "Decisions", rows: "decisions", kind: "events" },
  spend: { name: "Spend", rows: "usage records", kind: "events", value: "cost_usd" },
  usage: { name: "Requests", rows: "request-count rows (sum n for requests)", kind: "samples", value: "n" },
  signins: { name: "Sign-ins", rows: "sign-ins", kind: "events" },
  tokens: { name: "API tokens", rows: "tokens", kind: "events" },
  adminActions: { name: "Admin actions", rows: "admin actions", kind: "events" },
  machine: { name: "Machine readings", rows: "15-second readings", kind: "samples", value: "cpu_cores", filter: { column: "target", op: "eq", value: "forge" } },
  efficiency: { name: "Efficiency by cause", rows: "hourly readings", kind: "samples", value: "value", filter: { column: "cause", op: "eq", value: "npm-registry-bytes" } },
  reach: { name: "Visitors and page speed", rows: "daily figures", kind: "samples", value: "value", filter: { column: "metric", op: "eq", value: "visitors" } },
  app_vital: { name: "App page speed", rows: "app-days", kind: "samples", value: "load_p75" },
  keeperReleases: { name: "Releases", rows: "releases", kind: "events" },
  spawns: { name: "Forges made", rows: "spawn events", kind: "events" },
  spawnTime: { name: "Time to a live forge", rows: "daily figures", kind: "samples", value: "value", filter: { column: "metric", op: "eq", value: "p95" } },
  restarts: { name: "App restarts", rows: "restarts", kind: "events" },
  queueVerdicts: { name: "Red merge batches", rows: "verdicts", kind: "events" },
  stages: { name: "Work by stage", rows: "items entering a stage", kind: "events" },
};

/** What a column is, in a few plain words, with its unit, where sources.ts has no doc for it. */
export const NOTES: Readonly<Record<string, string>> = {
  id: "its id", repo_id: "the repository", issue_id: "the issue or pull", actor_id: "who did it", agent_id: "the agent",
  user_id: "the account", created_at: "when it was made", started_at: "when it started", finished_at: "when it finished",
  serving_at: "when it began serving", state: "its state", kind: "its kind", cost_usd: "cost in US dollars",
  tokens_in: "tokens read", tokens_out: "tokens written", wall_ms: "wall-clock time, ms", turns: "model turns",
  attempt: "which attempt", subscription_id: "the subscription paid from", by: "who decided", p: "the probability given, 0 to 1",
  ms: "milliseconds", outcome: "how it ended", at: "when", access: "who can open it", placement: "app and environment",
  merged_at: "when it merged", merged_by: "who merged it", head_repo_id: "the repository the pull came from",
  author_id: "the reviewer", expires_at: "when it expires", last_used_at: "when last used", last_seen_at: "when last seen",
  scope: "what it may do", preview_data: "how a preview gets data", ended_at: "when it ended",
  version: "the release", stage: "the stage", pull_number: "the pull's number", action: "what was done", why: "the reason",
  cause: "why", app: "the app", route: "the route pattern", metric: "which figure", value: "the figure", series: "the split", step: "the step",
  outcome_at: "when the outcome was known", day: "the day, UTC", reports: "reports kept",
};

/** The unit of a number column, by name; `UNIT_OF` overrides it where one name means two things. */
const UNITS: Readonly<Record<string, string>> = {
  cost_usd: "US dollars", turns: "model turns", attempt: "attempts", tokens_in: "tokens", tokens_out: "tokens", wall_ms: "ms",
  p: "probability, 0 to 1", ms: "ms", n: "requests", step: "seconds", cpu_cores: "cores", cpu_cores_max: "cores",
  memory_bytes: "bytes", memory_bytes_max: "bytes", load: "runnable tasks", celsius: "°C", celsius_max: "°C",
  lag_ms: "ms", lag_ms_max: "ms", checks: "runs", agents: "runs", load_p75: "ms", inp_p75: "ms", reports: "reports",
  roll_probes: "probes", roll_non200: "probes", probes: "probes", pages: "pages", bad_in_row: "probes", worst_ms: "ms",
  seconds_dark: "seconds", pull_number: "pull number", value: "a count, ms or score by metric",
};
const UNIT_OF: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  reach: { value: "visitors, ms or a score, by metric" },
  spawnTime: { value: "ms" },
  load: { load: "runnable tasks" },
};

/** A number column's unit; empty for text and time columns. */
export function unitOf(source: string, column: string): string {
  const src = Object.hasOwn(SOURCES, source) ? SOURCES[source]! : undefined;
  if (src?.columns[column] !== "number") return "";
  return UNIT_OF[source]?.[column] ?? UNITS[column] ?? "";
}

/** A column's meaning and unit: the source's own doc, else the shared note, else its type. */
export function columnNote(source: string, column: string): string {
  const src = Object.hasOwn(SOURCES, source) ? SOURCES[source]! : undefined;
  return src?.docs?.[column] ?? NOTES[column] ?? src?.columns[column] ?? "";
}

const short = (s: string, n = 56) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/[\s,;:(]+\S*$/, "")}…`);
/** `column — meaning`, short enough for an option. */
export const columnOption = (source: string, column: string) => {
  const unit = unitOf(source, column);
  return `${column}${unit === "" ? "" : ` (${unit})`} — ${short(columnNote(source, column))}`;
};

/** A column's name as a person says it: `cpu_cores` is "CPU cores". */
export function columnWords(column: string): string {
  return column.replace(/_/g, " ").replace(/\bcpu\b/g, "CPU").replace(/\busd\b/g, "USD").replace(/\bp75\b/, "75th percentile");
}

const AGG_WORD: Record<string, string> = { count: "Count", sum: "Total", avg: "Average", max: "Highest" };
/**
 * An aggregate's option label, saying what it aggregates: the column picked
 * (else the source's default value column) with its unit — "average of CPU
 * cores (cores)". With no column to name it says the column is picked below.
 */
export const aggregateOption = (source: string, a: string, column = ""): [string, string] => {
  const g = Object.hasOwn(GUIDE, source) ? GUIDE[source]! : undefined;
  if (a === "count") return [a, g ? `count of ${g.rows}${g.kind === "samples" ? " (counts readings, not time)" : ""}` : "count"];
  const word = AGG_WORD[a]?.toLowerCase() ?? a;
  const col = column !== "" ? column : (g?.value ?? "");
  if (col === "") return [a, `${word} of the column picked below`];
  const unit = unitOf(source, col);
  return [a, `${word} of ${columnWords(col)}${unit === "" ? "" : ` (${unit})`}`];
};

export type Shown = {
  source: string; aggregate: string; column: string; by: string; series: string;
  from: string; to: string; fcolumn: string; fop: string; fvalue: string;
};

const OP_WORD: Record<string, string> = { eq: "is", ne: "is not", lt: "is below", lte: "is at most", gt: "is above", gte: "is at least", starts: "starts with" };
const day = (iso: string) => (/^\d{4}-\d\d-\d\d/.test(iso) ? iso.slice(0, 10) : iso);

/** One line that says what a chart shows: "Average CPU cores per day, by machine". */
export function sentence(p: Shown): string {
  const g = Object.hasOwn(GUIDE, p.source) ? GUIDE[p.source]! : undefined;
  const what = p.aggregate === "count" || p.column === ""
    ? `${AGG_WORD.count} of ${g?.rows ?? p.source}`
    : `${AGG_WORD[p.aggregate] ?? p.aggregate} ${columnWords(p.column)}`;
  const bucket = p.by === "minute" || p.by === "hour" || p.by === "day";
  let s = `${what} ${bucket ? `per ${p.by}` : `by ${columnWords(p.by)}`}`;
  if (p.series !== "") s += `, by ${p.series === "target" ? "machine" : columnWords(p.series)}`;
  if (p.fcolumn !== "") s += `, where ${columnWords(p.fcolumn)} ${OP_WORD[p.fop] ?? p.fop} ${p.fvalue}`;
  if (p.from !== "" && p.to !== "") s += `, ${day(p.from)} to ${day(p.to)}`;
  else if (p.from !== "") s += `, since ${day(p.from)}`;
  else if (p.to !== "") s += `, until ${day(p.to)}`;
  return `${s}.`;
}

/** The query's own defaults for a source: an average over time for samples, a count per day for events. */
export function defaultsFor(source: string): { aggregate: string; column: string; by: string; fcolumn: string; fop: string; fvalue: string } {
  const g = Object.hasOwn(GUIDE, source) ? GUIDE[source]! : undefined;
  const f = g?.filter;
  const filter = { fcolumn: f?.column ?? "", fop: f?.op ?? "eq", fvalue: f?.value ?? "" };
  if (g?.kind === "samples" && g.value) return { aggregate: "avg", column: g.value, by: "day", ...filter };
  return { aggregate: "count", column: "", by: "day", ...filter };
}

/** A ready question: its label and the form fields it fills. `days` sets `from` that long before now. */
export type Question = {
  label: string; source: string; featured?: true; days?: number; today?: true;
  fill: Partial<Record<"chart" | "aggregate" | "column" | "by" | "series" | "fcolumn" | "fop" | "fvalue", string>>;
};

export const QUESTIONS: readonly Question[] = [
  { label: "CPU over the last week", source: "machine", featured: true, days: 7, fill: { chart: "line", aggregate: "avg", column: "cpu_cores", by: "hour", fcolumn: "target", fop: "eq", fvalue: "forge" } },
  { label: "Memory over the last 3 days", source: "machine", days: 3, fill: { chart: "line", aggregate: "avg", column: "memory_bytes", by: "hour", fcolumn: "target", fop: "eq", fvalue: "forge" } },
  { label: "Busiest cores, last hour", source: "machine", days: 1 / 24, fill: { chart: "bar", aggregate: "avg", column: "cpu_cores", by: "target", fcolumn: "target", fop: "starts", fvalue: "cpu:" } },
  { label: "Temperature over the last day", source: "machine", days: 1, fill: { chart: "line", aggregate: "max", column: "celsius_max", by: "hour", fcolumn: "target", fop: "starts", fvalue: "package:" } },
  { label: "Slowest pages today", source: "reach", featured: true, today: true, fill: { chart: "bar", aggregate: "max", column: "value", by: "route", fcolumn: "metric", fop: "eq", fvalue: "server_p95" } },
  { label: "Visitors per day, last month", source: "reach", days: 30, fill: { chart: "line", aggregate: "avg", column: "value", by: "day", fcolumn: "metric", fop: "eq", fvalue: "visitors" } },
  { label: "Who used the forge's time", source: "spend", featured: true, days: 7, fill: { chart: "bar", aggregate: "sum", column: "wall_ms", by: "agent_id" } },
  { label: "Spend per day, last month", source: "spend", days: 30, fill: { chart: "bar", aggregate: "sum", column: "cost_usd", by: "day" } },
  { label: "Apps shipped per day", source: "stages", featured: true, days: 30, fill: { chart: "bar", aggregate: "count", column: "", by: "day", fcolumn: "stage", fop: "eq", fvalue: "5 live" } },
  { label: "Pulls merged per day", source: "pulls", days: 30, fill: { chart: "bar", aggregate: "count", column: "", by: "day" } },
  { label: "Runs per day by state", source: "runs", days: 14, fill: { chart: "area", aggregate: "count", column: "", by: "day", series: "state" } },
  { label: "Deploys per day", source: "deploys", days: 14, fill: { chart: "bar", aggregate: "count", column: "", by: "day" } },
  { label: "Requests per day by status", source: "usage", days: 7, fill: { chart: "area", aggregate: "sum", column: "n", by: "day", series: "status" } },
];

const ISO = (ms: number) => new Date(Math.floor(ms / 60_000) * 60_000).toISOString();

/** The `from` a question or a phrase asks for, from `now`. */
export const since = (now: number, days: number) => ISO(now - days * 86_400_000);
export const startOfToday = (now: number) => `${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`;

/** The form fields a question fills, `from` included. */
export function ask(q: Question, now: number): Record<string, string> {
  return {
    source: q.source, series: "", fcolumn: "", fop: "eq", fvalue: "", column: "", ...q.fill,
    ...(q.today ? { from: startOfToday(now) } : q.days !== undefined ? { from: since(now, q.days) } : {}),
  };
}

/** What a sentence may name: words that pick a question's fields. First match in this order wins. */
const TOPICS: readonly { words: RegExp; fill: Question["fill"] & { source: string }; by?: string }[] = [
  { words: /\b(cpu|processor|cores?)\b/, fill: { source: "machine", aggregate: "avg", column: "cpu_cores", fcolumn: "target", fop: "eq", fvalue: "forge" } },
  { words: /\b(memory|ram)\b/, fill: { source: "machine", aggregate: "avg", column: "memory_bytes", fcolumn: "target", fop: "eq", fvalue: "forge" } },
  { words: /\b(temperature|temp|heat|hot|celsius)\b/, fill: { source: "machine", aggregate: "max", column: "celsius_max", fcolumn: "target", fop: "starts", fvalue: "package:" } },
  { words: /\b(load average|load)\b/, fill: { source: "machine", aggregate: "avg", column: "load", fcolumn: "target", fop: "eq", fvalue: "node" } },
  { words: /\b(slow|slowest|latency|response time|ttfb)\b/, fill: { source: "reach", aggregate: "max", column: "value", by: "route", chart: "bar", fcolumn: "metric", fop: "eq", fvalue: "server_p95" } },
  { words: /\b(visitors?|traffic)\b/, fill: { source: "reach", aggregate: "avg", column: "value", fcolumn: "metric", fop: "eq", fvalue: "visitors" } },
  { words: /\b(spend|spent|cost|costs|money|dollars)\b/, fill: { source: "spend", aggregate: "sum", column: "cost_usd" } },
  { words: /\b(tokens)\b/, fill: { source: "spend", aggregate: "sum", column: "tokens_out" } },
  { words: /\b(shipped|ships|went live)\b/, fill: { source: "stages", aggregate: "count", fcolumn: "stage", fop: "eq", fvalue: "5 live" } },
  { words: /\b(deploys?|deployments?)\b/, fill: { source: "deploys", aggregate: "count" } },
  { words: /\b(merged|pulls?)\b/, fill: { source: "pulls", aggregate: "count" } },
  { words: /\b(reviews?)\b/, fill: { source: "reviews", aggregate: "count" } },
  { words: /\b(sign-?ins?|logins?)\b/, fill: { source: "signins", aggregate: "count" } },
  { words: /\b(runs?|builds?)\b/, fill: { source: "runs", aggregate: "count" } },
  { words: /\b(requests?)\b/, fill: { source: "usage", aggregate: "sum", column: "n" } },
];

const UNIT_DAYS: Record<string, number> = { minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7, month: 30, year: 365 };

/**
 * A sentence ("memory over the last 3 days") as the form it fills, or null
 * when no topic in it is known. Deterministic: no model is asked.
 */
export function parseSentence(text: string, now: number): Record<string, string> | null {
  const t = text.toLowerCase().slice(0, 200);
  const topic = TOPICS.find((x) => x.words.test(t));
  if (!topic) return null;
  const out: Record<string, string> = { series: "", fcolumn: "", fop: "eq", fvalue: "", column: "", chart: "line", ...topic.fill };
  const g = GUIDE[out.source!]!;
  out.by = topic.fill.by ?? "day";
  if (g.kind === "events" && out.chart === "line") out.chart = "bar";
  let days: number | undefined;
  const n = /\b(?:last|past|previous)\s+(\d{1,3})\s+(minute|hour|day|week|month|year)s?\b/.exec(t);
  if (n) days = Number(n[1]) * UNIT_DAYS[n[2]!]!;
  else {
    const w = /\b(?:last|past)\s+(hour|day|week|month|year)\b/.exec(t) ?? /\bthis\s+(week|month)\b/.exec(t);
    if (w) days = UNIT_DAYS[w[1]!]!;
    else if (/\byesterday\b/.test(t)) {
      out.from = since(Date.parse(startOfToday(now)), 1);
      out.to = startOfToday(now);
    } else if (/\b(today|so far today)\b/.test(t)) out.from = startOfToday(now);
    else if (/\b(a week|weekly)\b/.test(t)) days = 7;
  }
  if (days !== undefined) out.from = since(now, days);
  if (out.by === "day" && days !== undefined && days <= 3 && g.kind === "samples") out.by = "hour";
  if (out.by === "day" && days !== undefined && days <= 1 / 24 * 3 && g.kind === "samples") out.by = "minute";
  if (/\bper (minute|hour|day)\b|\bby (minute|hour|day)\b|\b(hourly|daily)\b/.test(t)) {
    out.by = /minute/.test(t) ? "minute" : /hour/.test(t) ? "hour" : "day";
  }
  if (/\bby (machine|target)\b|\bper (machine|core)\b/.test(t) && out.source === "machine") {
    out.series = "target"; out.fcolumn = ""; out.fvalue = ""; out.chart = "area";
  }
  return out;
}
