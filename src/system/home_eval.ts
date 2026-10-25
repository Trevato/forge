/**
 * Scoring the owner's home against ground truth (#5805): plain data in, one
 * verdict per fact out. `stated` is right, `missing` is absent, `wrong` is a
 * claim the page makes that the forge's own figures contradict. The page's
 * words come from `pageText` (#5765); the truth from `homeTruth` and the
 * repository API, gathered by `scripts/home-eval.ts`.
 */

export type Verdict = "stated" | "missing" | "wrong";

export interface Truth {
  readonly landed: number;
  readonly live: { readonly sha: string } | null;
  readonly builders: { readonly running: number; readonly slots: number; readonly idle: string | null };
  readonly spend: { readonly todayUsd: number; readonly ceilingUsd: number | null };
  readonly waiting: { readonly count: number };
  /** Every repository the owner sees, and which of them have had no commit in 3 days. */
  readonly repos: readonly string[];
  readonly quiet: readonly string[];
}

export interface Fact {
  readonly key: "landed" | "waiting" | "spend" | "builders" | "quiet";
  readonly label: string;
  readonly verdict: Verdict;
  /** The page's words for it, or "" when it says nothing. */
  readonly words: string;
  /** What the forge says, for the reader to compare. */
  readonly truth: string;
}

const lineWith = (text: string, re: RegExp): string => text.split("\n").find((l) => re.test(l)) ?? "";
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
const usd = (n: number): string => (n < 10 ? n.toFixed(2) : String(Math.round(n)));

function landed(text: string, t: Truth): Fact {
  const m = /(\d+) changes? in 24 h/.exec(text);
  const sha = t.live === null ? null : t.live.sha.slice(0, 7);
  const truth = `${t.landed} ${t.landed === 1 ? "change" : "changes"} in 24 h${sha === null ? ", nothing live" : `, live ${sha}`}`;
  const words = m === null ? "" : m[0] + (sha !== null && text.includes(sha) ? ` · ${sha}` : "");
  const verdict: Verdict = m === null ? "missing" : Number(m[1]) !== t.landed ? "wrong" : sha === null || text.includes(sha) ? "stated" : "missing";
  return { key: "landed", label: "landed and released", verdict, words, truth };
}

function waiting(text: string, t: Truth): Fact {
  const m = /(\d+) waiting on you/.exec(text);
  const n = t.waiting.count;
  const verdict: Verdict = m === null ? (n === 0 ? "stated" : "missing") : Number(m[1]) === n ? "stated" : "wrong";
  return { key: "waiting", label: "waiting on the owner", verdict, words: m === null ? "" : flat(lineWith(text, /waiting on you/)), truth: `${n} waiting on you` };
}

function spend(text: string, t: Truth): Fact {
  const m = /Crew spend today\s+\$([\d.]+)(?:\s+of\s+\$([\d.]+))?(\s+no ceiling)?/.exec(text);
  const { todayUsd, ceilingUsd } = t.spend;
  const truth = `$${usd(todayUsd)} of ${ceilingUsd === null ? "no ceiling" : `$${usd(ceilingUsd)}`}`;
  if (m === null) return { key: "spend", label: "spend against the forge cap", verdict: "missing", words: "", truth };
  const pageCeiling = m[2] === undefined ? null : Number(m[2]);
  const right = Math.abs(Number(m[1]) - todayUsd) <= 1 && (ceilingUsd === null ? pageCeiling === null : pageCeiling !== null && Math.abs(pageCeiling - ceilingUsd) <= 0.5);
  return { key: "spend", label: "spend against the forge cap", verdict: right ? "stated" : "wrong", words: flat(m[0]), truth };
}

const REASONS: readonly [RegExp, RegExp][] = [
  [/ceiling of \$/, /ceiling (reached|hit)|reached (the |its )?(daily |forge )?ceiling|paused at (the )?(forge )?ceiling/i],
  [/^no slots set$/, /no slots set/i],
  [/^no ready work$/, /no ready work|nothing (is )?ready/i],
];

function builders(text: string, t: Truth): Fact {
  const { running, slots, idle } = t.builders;
  const truth = `${running} of ${slots} running${idle === null ? "" : `, idle: ${idle}`}`;
  const m = /Builders running\s+(?:(\d+) of (\d+)|—)/.exec(text);
  if (m === null) return { key: "builders", label: "builders idle and why", verdict: "missing", words: "", truth };
  const words = flat(m[0]);
  const countRight = m[1] === undefined ? slots === 0 : Number(m[1]) === running && Number(m[2]) === slots;
  if (!countRight) return { key: "builders", label: "builders idle and why", verdict: "wrong", words, truth };
  if (idle === null) return { key: "builders", label: "builders idle and why", verdict: "stated", words, truth };
  const why = REASONS.find(([truthRe]) => truthRe.test(idle))?.[1];
  const said = why === undefined ? "" : lineWith(text, why);
  return { key: "builders", label: "builders idle and why", verdict: said === "" ? "missing" : "stated", words: said === "" ? words : flat(said), truth };
}

const QUIET_LINE = /no commit|quiet|stalled|silent/i;
const names = (repo: string): string[] => [repo, repo.split("/")[1] ?? repo];
const mentions = (line: string, repo: string): boolean => names(repo).some((n) => new RegExp(`(^|[^\\w/-])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w/-])`).test(line));

function quiet(text: string, t: Truth): Fact {
  const truth = t.quiet.length === 0 ? "none" : t.quiet.join(", ");
  const lines = text.split("\n").filter((l) => QUIET_LINE.test(l));
  const wrongLine = lines.find((l) => t.repos.some((r) => !t.quiet.includes(r) && mentions(l, r) && !t.quiet.some((q) => mentions(l, q))));
  if (wrongLine !== undefined) return { key: "quiet", label: "repositories with no commit in 3 days", verdict: "wrong", words: flat(wrongLine), truth };
  if (t.quiet.length === 0) return { key: "quiet", label: "repositories with no commit in 3 days", verdict: "stated", words: "", truth };
  const said = lines.filter((l) => t.quiet.some((q) => mentions(l, q)));
  const all = t.quiet.every((q) => said.some((l) => mentions(l, q)));
  return { key: "quiet", label: "repositories with no commit in 3 days", verdict: all ? "stated" : "missing", words: flat(said.join(" ")), truth };
}

export function scoreHome(text: string, truth: Truth): Fact[] {
  return [landed(text, truth), waiting(text, truth), builders(text, truth), spend(text, truth), quiet(text, truth)];
}

export const coverage = (facts: readonly Fact[]): number => facts.filter((f) => f.verdict === "stated").length;
export const errors = (facts: readonly Fact[]): number => facts.filter((f) => f.verdict === "wrong").length;
