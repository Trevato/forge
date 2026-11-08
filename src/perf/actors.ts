/**
 * One actor across addresses: captured requests grouped by what they share
 * (user agent, header names and order, language, accept, encoding,
 * sec-fetch-site), each group with its size, rate, addresses, the commits it
 * walked, its cadence and Cloudflare's bot score if sent, and a confidence
 * stated with the reasons for it.
 *
 * A group is a claim that requests look alike, not that one party sent them.
 * Traits every browser of one version shares prove little, so confidence rests
 * on the strong signals (a steady cadence, a walk through commits, a bot score)
 * and the page says what the evidence cannot show. Nothing here names anyone.
 */

import type { CapturedRequest } from "./capture.ts";
import { isCommit } from "./reads.ts";

export type Confidence = "low" | "medium" | "high";

export interface Group {
  readonly id: string;
  readonly ua: string;
  readonly language: string;
  readonly size: number;
  readonly addresses: readonly string[];
  readonly prefixes: readonly string[];
  readonly perMinute: number;
  readonly spanMs: number;
  readonly commits: readonly string[];
  readonly cadence: "steady" | "uneven" | "too few to say";
  readonly botScore: { readonly min: number; readonly max: number } | null;
  readonly confidence: Confidence;
  /** What the confidence rests on, and what it lacks. */
  readonly reasons: readonly string[];
  readonly requests: readonly CapturedRequest[];
}

const key = (r: CapturedRequest): string =>
  [r.ua, r.shape, r.language, r.accept, r.encoding, r.fetchSite].join("\u0000");

const idOf = (k: string): string => (Number(Bun.hash.xxHash32(k)) >>> 0).toString(16).padStart(8, "0");

/** Is the gap between requests steady: at least 10 gaps and a coefficient of variation under 0.5. */
function cadenceOf(times: readonly number[]): Group["cadence"] {
  if (times.length < 11) return "too few to say";
  const sorted = [...times].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((t, i) => t - sorted[i]!);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (mean <= 0) return "steady";
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  return sd / mean < 0.5 ? "steady" : "uneven";
}

export function groupRequests(entries: readonly CapturedRequest[]): Group[] {
  const by = new Map<string, CapturedRequest[]>();
  for (const e of entries) by.set(key(e), [...(by.get(key(e)) ?? []), e]);
  const groups: Group[] = [];
  for (const [k, list] of by) {
    const addresses = [...new Set(list.map((r) => r.address))];
    const prefixes = [...new Set(list.map((r) => r.prefix))];
    const times = list.map((r) => r.at);
    const spanMs = Math.max(...times) - Math.min(...times);
    const commits = [...new Set(list.flatMap((r) => (r.read !== null && isCommit(r.read.ref) ? [r.read.ref] : [])))];
    const scores = list.flatMap((r) => (r.botScore === null ? [] : [r.botScore]));
    const cadence = cadenceOf(times);
    const botScore = scores.length === 0 ? null : { min: Math.min(...scores), max: Math.max(...scores) };
    const strong = [cadence === "steady", commits.length >= 3, botScore !== null && botScore.max <= 29];
    const strongN = strong.filter(Boolean).length;
    const size = list.length;
    const confidence: Confidence =
      strongN >= 2 && size >= 20 ? "high" : strongN >= 1 && size >= 10 && addresses.length >= 2 ? "medium" : "low";
    const reasons = [
      addresses.length >= 2
        ? `${addresses.length} addresses sent requests with the same user agent and headers.`
        : "Only one address: nothing here spans addresses.",
      cadence === "steady" ? "Requests arrive at a steady pace." : cadence === "uneven" ? "Requests arrive unevenly, as people's do." : "Too few requests to judge their pace.",
      commits.length >= 3 ? `They read ${commits.length} different commits.` : "They did not walk a run of commits.",
      botScore === null ? "No bot score was sent." : `Cloudflare's bot score was ${botScore.min === botScore.max ? botScore.min : `${botScore.min} to ${botScore.max}`} (low means likely automated).`,
      size < 20 ? "Few requests: a small sample." : `${size} requests.`,
      confidence === "low" && strongN === 0 ? "Traits that browsers of one version share are weak evidence on their own." : "",
    ].filter((r) => r !== "");
    groups.push({
      id: idOf(k),
      ua: list[0]!.ua,
      language: list[0]!.language,
      size,
      addresses,
      prefixes,
      perMinute: Math.round((size / Math.max(1, spanMs / 60_000)) * 10) / 10,
      spanMs,
      commits,
      cadence,
      botScore,
      confidence,
      reasons,
      requests: list,
    });
  }
  const rank: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
  return groups.sort((a, b) => b.size - a.size || rank[b.confidence] - rank[a.confidence]);
}
