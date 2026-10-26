/**
 * The cold-read audit's plain data: which pages, at which widths, how an
 * answer is read, scored and merged into `docs/design/baseline.json`. No
 * network and no model here; `scripts/cold-read.ts` does those.
 */

/** Order of work: /migrate, /, a new forge's first run, then the rest by traffic. */
export const PAGES = ["/migrate", "/", "/forges/new", "/settings"] as const;

/** The repository pages, for `--repo owner/name`: repo, pulls, issues. */
export const repoPages = (repo: string): string[] => [`/${repo}`, `/${repo}/pulls`, `/${repo}/issues`];

export const REPO = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,64}$/;

/**
 * A reading is of the page asked for or it is nothing: a redirect (a sign-in),
 * a 404 or any non-200 is refused with the reason, never scored under the
 * asked-for page's name. `location` is the redirect target when there is one.
 */
export function refusal(path: string, status: number, location?: string | null): string | null {
  if (status >= 300 && status < 400) return `${path} redirects to ${location ?? "elsewhere"} (${status}), not the page itself`;
  if (status !== 200) return `${path} answered ${status}`;
  return null;
}

/** Titles of findings already open, normalised, so a second run skips them. */
export const titleKey = (t: string): string => t.trim().toLowerCase();

/** What to file: not above `cap`, none already open, none twice. */
export function toFile<T extends { title: string }>(found: readonly T[], open: ReadonlySet<string>, cap: number): T[] {
  const seen = new Set(open);
  const out: T[] = [];
  for (const f of found) {
    const k = titleKey(f.title);
    if (seen.has(k) || out.length >= cap) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

export const WIDTHS = [
  { width: 390, height: 844, device: "phone" },
  { width: 1440, height: 900, device: "desktop" },
] as const;

export const MAX_WORDS = 100;

export interface Answer {
  readonly confusing: readonly string[];
  readonly clickFirst: string;
  readonly clarity: number;
}

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;

/** The model's reply as an Answer, or why it is not one. Untrusted text in, bounded data out. */
export function parseAnswer(raw: string): Answer | string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) return "no JSON object in the reply";
  let o: unknown;
  try {
    o = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return "the reply is not valid JSON";
  }
  if (typeof o !== "object" || o === null) return "the reply is not an object";
  const r = o as Record<string, unknown>;
  const { confusing, clickFirst, clarity } = r;
  if (!Array.isArray(confusing) || !confusing.every((c) => typeof c === "string")) return "confusing must be a list of strings";
  if (typeof clickFirst !== "string") return "clickFirst must be a string";
  if (typeof clarity !== "number" || !Number.isInteger(clarity) || clarity < 1 || clarity > 5) return "clarity must be an integer 1-5";
  const list = confusing.map((c) => c.trim()).filter(Boolean).slice(0, 8);
  return { confusing: list, clickFirst: clickFirst.trim(), clarity };
}

export const answerWords = (a: Answer): number => a.confusing.reduce((n, c) => n + words(c), words(a.clickFirst));

export interface PageScore {
  /** Mean clarity (1-5) over the widths that answered. */
  readonly clarity: number;
  readonly phone: number | null;
  readonly desktop: number | null;
  readonly confusions: number;
  readonly words: number;
}

export interface Reading {
  readonly device: string;
  readonly answer: Answer;
}

export function scorePage(readings: readonly Reading[]): PageScore | null {
  if (readings.length === 0) return null;
  const of = (d: string) => readings.find((r) => r.device === d)?.answer.clarity ?? null;
  const mean = readings.reduce((n, r) => n + r.answer.clarity, 0) / readings.length;
  return {
    clarity: Math.round(mean * 10) / 10,
    phone: of("phone"),
    desktop: of("desktop"),
    confusions: readings.reduce((n, r) => n + r.answer.confusing.length, 0),
    words: readings.reduce((n, r) => n + answerWords(r.answer), 0),
  };
}

export interface ColdRead {
  readonly at: string;
  /** The parent issue, when `--file-issues` named one. */
  readonly issue?: number;
  /** `text-only` when there was no Chromium: the two widths read the same words. */
  readonly mode: "screenshot" | "text-only";
  readonly pages: Record<string, PageScore>;
}

/** The baseline with `coldRead` set, every other key kept as it was. */
export function withColdRead(baseline: Record<string, unknown>, coldRead: ColdRead): Record<string, unknown> {
  return { ...baseline, coldRead };
}

/** One finding as an issue: a title that names the page and the blamed text, a body that links back. */
export function findingIssue(page: string, device: string, text: string, parent: number): { title: string; body: string } {
  const title = `Cold read ${page} (${device}): ${text}`.slice(0, 120);
  return {
    title,
    body: `A no-context agent reading ${page} at ${device} width said:\n\n> ${text.replace(/\n/g, " ")}\n\nFound by the cold-read audit (\`bun scripts/cold-read.ts\`), part of #${parent}.`,
  };
}

/** Why `--write` must not store this run, or null. A baseline is never written from a partial or text-only read. */
export function writeRefusal(run: { failed: Record<string, string[]>; mode: string }, allowTextOnly: boolean): string | null {
  if (run.mode === "text-only" && !allowTextOnly) return "refusing to --write a text-only score (no Chromium): install it, or pass --allow-text-only to record it marked text-only";
  if (Object.keys(run.failed).length > 0) return "refusing to --write: some pages were not read (is FORGE_TOKEN honoured on pages?)";
  return null;
}

/**
 * Where findings are filed and which of them: `error` when the target is not
 * the forge that was read, or not named; otherwise the issues URL and the
 * findings that are neither open already, repeated, nor over `cap`.
 */
export function filingPlan(o: {
  forge: string | undefined;
  base: string;
  into: string | undefined;
  open: readonly string[];
  findings: readonly { page: string; device: string; text: string }[];
  parent: number;
  cap: number;
}): { error: string } | { url: string; filing: { title: string; body: string; page: string; device: string }[]; skipped: number } {
  if (!o.forge) return { error: "--file-issues needs FORGE_URL" };
  if (!o.into) return { error: "--file-issues needs --repo or --file-into: the repository to file into" };
  let same = false;
  try {
    same = new URL(o.forge).origin === new URL(o.base).origin;
  } catch {
    /* not a URL: not the same */
  }
  if (!same) return { error: `FORGE_URL (${o.forge}) is not ${o.base}: findings are filed only into the forge that was read` };
  const mine = o.findings.map((f) => ({ ...f, ...findingIssue(f.page, f.device, f.text, o.parent) }));
  const filing = toFile(mine, new Set(o.open.map(titleKey)), o.cap);
  return { url: `${o.forge.replace(/\/$/, "")}/api/v1/repos/${o.into}/issues`, filing, skipped: mine.length - filing.length };
}

/**
 * Whether `FORGE_TOKEN` may be sent to `base`: only to the forge `FORGE_URL`
 * names. Checked before the first request, so a mistyped or foreign URL never
 * receives the token. Null when it may; otherwise why not.
 */
export function tokenRefusal(base: string, forge: string | undefined): string | null {
  if (!forge) return "FORGE_URL is not set: the token is sent only to the forge it names";
  try {
    if (new URL(base).origin === new URL(forge).origin) return null;
  } catch {
    /* fall through */
  }
  return `${base} is not the forge in FORGE_URL (${forge}): FORGE_TOKEN is not sent there`;
}
