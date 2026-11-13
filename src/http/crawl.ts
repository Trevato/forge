/**
 * What an unauthenticated crawler may spend (#8129).
 *
 * On 2026-11-02 one crawler made 907 requests in 15 minutes, mostly blob and
 * commit pages, and cost half the forge's server time. `robots.txt` asks
 * politely; this is the mechanical half. A request with no session and no
 * token whose User-Agent names itself a crawler (or names nothing) is counted
 * against three budgets and, past any of them, answered 429 with Retry-After
 * before any page work: its client address (`peer.ts`, the socket's peer, the
 * only key a client cannot write; an IPv6 client by its /64), its agent (the
 * product token of the User-Agent, a second cap only, since anyone can
 * send `Googlebot`), and one shared budget for every such crawler, so their
 * total cost has a ceiling however they rotate. A browser-looking User-Agent
 * is counted only on the deep paths, with a looser budget of its own. Deep paths (blob, raw, commits, blame, diffs at every ref) have a
 * far smaller budget than the rest. When the event loop is late the budgets
 * shrink, so a crawler is the first to wait. A signed-in person or a token is
 * never counted here: the check is made only for a request `resolveAuth`
 * found no one behind. In memory, like `strangers.ts`: a restart forgives.
 */

import type { App } from "../app.ts";
import { RateLimiter } from "../core/ratelimit.ts";
import { startLoopLag } from "../kernel/loop_lag.ts";
import { bucketOf, clientAddress } from "./peer.ts";

/** Requests per minute per client address: any page, and the deep ones that cost a git walk. */
export const CRAWL_BUDGET = { page: 60, deep: 6 } as const;
/** The second cap per agent name (a name is the client's word, so it is looser than an address). */
export const AGENT_BUDGET = { page: 120, deep: 12 } as const;
/** The ceiling for every crawler together. */
export const SHARED_BUDGET = { page: 240, deep: 24 } as const;
/**
 * Deep pages per minute, per address, for a reader whose User-Agent looks like
 * a browser (#8199): anyone can write that header, so what it may spend on the
 * pages that cost a git walk is bound too. Far looser than a crawler's, since
 * people click. On time, there is deliberately no bucket for all such readers
 * together: a few addresses could spend it and shut every other person out.
 * Behind, there is: on 2026-11-03 browser-looking strangers on too many
 * addresses for any one to reach its budget sent 31 deep pages a second, took
 * 91% of the forge's answering time and left it stalling for everyone.
 * `behindAll` is what they may spend together, per minute, only while the loop
 * is late. A signed-in person or a token is never counted.
 *
 * Late isn't only the loop: a test at 100 pages a second (#9405) left the loop
 * on time while pages queued on git for seconds and people waited behind them.
 * So `inFlight` of these pages unanswered at once counts as behind too, once
 * the oldest of them has waited `queuedMs`: a count alone is a rate times a
 * latency (Little's law), and at 500 pages a second 32 in flight is 64 ms
 * each, which is healthy; a 70 ms collector pause then throttled every
 * stranger to `behindAll` (#9514). Waiting a quarter second is queuing.
 */
export const STRANGER_BUDGET = { address: 30, behindAll: 60, inFlight: 32, queuedMs: 250 } as const;
/** A page unanswered this long no longer counts, so a lost finish can't hold the forge "behind" for good. */
const IN_FLIGHT_MAX_MS = 60_000;
/** The budgets divide by this while the event loop runs late. */
export const BEHIND_DIVISOR = 4;
/** An average wake later than this (ms) is "behind". */
export const BEHIND_MS = 50;
/** `Crawl-delay` in robots.txt, seconds. */
export const CRAWL_DELAY_S = 10;
const MAX_AGENTS = 256;
/** The agent name every name past `MAX_AGENTS` is counted under, so rotating names cannot grow the limiters. */
const OTHER = "other";

/** A User-Agent that says it is a crawler. Not curl, not a browser, not an HTTP library. */
const CRAWLER = /bot\b|bot[/ ;)-]|crawl|spider|slurp|scrap|archiver|reflection|facebookexternalhit|bingpreview|ia_archiver/i;

/** Paths whose answer costs a git walk or a diff: the ones robots.txt disallows. */
export const DEEP_SEGMENTS = ["blob", "raw", "commits", "commit", "blame", "compare", "diff", "tree", "history"] as const;
const DEEP = new RegExp(`^/(?:origins/[^/]+/r/)?[^/]+/[^/]+/(?:${DEEP_SEGMENTS.join("|")})(?:/|$)`);

/** Whether `pathname` is a page that costs a git walk or a diff. */
export const isDeepPath = (pathname: string): boolean => DEEP.test(pathname);

/**
 * What Sign-in only turns away: the deep pages, a repository's media, and the
 * API routes that read the same files and history. A clone (`.git`) stays open:
 * the Shield protects the pages, and turning clones off would break every mirror.
 */
const SHIELDED_API = /^\/api\/v1\/repos\/[^/]+\/[^/]+\/(?:contents|commits|git|raw|archive|media|tree|blob|compare|branches|tags)(?:\/|$)/;
const SHIELDED_MEDIA = /^\/(?:origins\/[^/]+\/r\/)?[^/]+\/[^/]+\/media(?:\/|$)/;
export const isShieldedPath = (pathname: string): boolean =>
  DEEP.test(pathname) || SHIELDED_MEDIA.test(pathname) || SHIELDED_API.test(pathname);

/** What a crawler never spends from: the files it is asked to read, and the probes. */
const FREE = /^\/(?:robots\.txt|sitemap\.xml|healthz|readyz|assets\/)/;

/** The product token of a User-Agent, lowercase and bounded: `Mozilla/5.0 (compatible; Reflectionbot/1.0)` is `reflectionbot`. */
export function agentOf(userAgent: string): string {
  const named = /([a-z][a-z0-9._-]{1,38}bot|[a-z][a-z0-9._-]{0,38}(?:crawler|spider|slurp|archiver))/i.exec(userAgent);
  const token = named?.[1] ?? /^\s*([a-z][a-z0-9._-]{0,39})/i.exec(userAgent)?.[1] ?? "unknown";
  return token.toLowerCase();
}

/**
 * A User-Agent as a family for the traffic board, from a short fixed set for
 * browsers (the header is the client's word) and the product token otherwise.
 */
export function familyOf(userAgent: string): string {
  const ua = userAgent.slice(0, 300);
  if (ua === "") return "none";
  if (!CRAWLER.test(ua) && /^Mozilla\//.test(ua)) {
    if (/\bEdg(?:e|A|iOS)?\//.test(ua)) return "edge";
    if (/\b(?:Chrome|Chromium|CriOS)\//.test(ua)) return "chrome";
    if (/\b(?:Firefox|FxiOS)\//.test(ua)) return "firefox";
    if (/\bSafari\//.test(ua)) return "safari";
    return "other browser";
  }
  return agentOf(ua);
}

/** Whether this request says it is a crawler and is one the budget counts. */
export function isCrawler(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const ua = request.headers.get("user-agent") ?? "";
  // No User-Agent at all is a script hiding, not a browser.
  return ua.length === 0 || CRAWLER.test(ua.slice(0, 300));
}

type Scope = "address" | "agent" | "shared" | "stranger";
interface Pair {
  readonly page: RateLimiter;
  readonly deep: RateLimiter;
}
interface State {
  readonly address: Pair;
  readonly agent: Pair;
  readonly shared: Pair;
  /** Deep pages read by browser-looking strangers, per address. */
  readonly strangerAddress: RateLimiter;
  /** The same, all of them together; counted only while the loop is behind. */
  readonly strangerAll: RateLimiter;
  /** Deep pages being answered for strangers, by when they started. */
  readonly strangersInFlight: Map<Request, number>;
  readonly refused: Map<string, number>;
  readonly refusedBy: Record<Scope, number>;
  readonly clock: { now: () => number; behind: boolean; pinned: boolean | undefined };
}

const states = new WeakMap<App, State>();
let lateMs = 0;
let lagStarted = false;

/** Start measuring lateness on the first crawler; an exponential average, so one slow wake is not "behind". */
function watchLag(): void {
  if (lagStarted) return;
  lagStarted = true;
  startLoopLag(100, undefined, (late) => {
    lateMs = lateMs * 0.8 + late * 0.2;
  });
}

/** Whether the event loop is running late enough that a crawler should wait. */
export const mainThreadBehind = (): boolean => lateMs > BEHIND_MS;

const limits = (perMinute: number) => ({ perMinute, adminPerMinute: perMinute, enabled: true });

function stateOf(app: App): State {
  let state = states.get(app);
  if (state === undefined) {
    const clock = { now: Date.now, behind: false, pinned: undefined as boolean | undefined };
    const pair = (b: { page: number; deep: number }): Pair => ({
      page: new RateLimiter(limits(b.page), () => clock.now()),
      deep: new RateLimiter(limits(b.deep), () => clock.now()),
    });
    state = {
      address: pair(CRAWL_BUDGET),
      agent: pair(AGENT_BUDGET),
      shared: pair(SHARED_BUDGET),
      strangerAddress: new RateLimiter(limits(STRANGER_BUDGET.address), () => clock.now()),
      strangerAll: new RateLimiter(limits(STRANGER_BUDGET.behindAll), () => clock.now()),
      strangersInFlight: new Map(),
      refused: new Map(),
      refusedBy: { address: 0, agent: 0, shared: 0, stranger: 0 },
      clock,
    };
    states.set(app, state);
  }
  return state;
}

/** Test seam: count by `now`, and say whether the main thread is behind. */
export function setCrawlClock(app: App, now: () => number, behind = false): void {
  const { clock } = stateOf(app);
  clock.now = now;
  clock.behind = behind;
}

/**
 * Test seam: say whether this app's budgets are divided for lag, whatever the
 * process measures. The lag reading is process-wide, so a file that tests
 * something else (not load shedding) pins it off and is not at the mercy of
 * whichever file ran before it in the shard; `undefined` measures again.
 */
export function pinCrawlLag(app: App, behind: boolean | undefined): void {
  stateOf(app).clock.pinned = behind;
}

export interface CrawlVerdict {
  readonly retryAfter: number;
  readonly agent: string;
  /** Which budget ran out. */
  readonly scope: Scope;
}

/**
 * Count one unauthenticated request. Undefined: let it through (not a
 * crawler, or inside its budget). Otherwise the refusal to answer with.
 */
export function takeCrawl(app: App, request: Request, pathname: string): CrawlVerdict | undefined {
  if (!isCrawler(request)) return takeStrangerDeep(app, request, pathname);
  if (FREE.test(pathname)) return undefined;
  watchLag();
  const state = stateOf(app);
  const behind = state.clock.pinned ?? (state.clock.behind || mainThreadBehind());
  const named = agentOf(request.headers.get("user-agent") ?? "");
  const scale = behind ? BEHIND_DIVISOR : 1;
  const deep = DEEP.test(pathname);
  const scaled = (budget: number) => limits(Math.max(1, Math.floor(budget / scale)));
  // A name nobody has used yet, once the table is full, is counted as "other".
  const agent = state.agent.page.has(named) || state.agent.page.size < MAX_AGENTS ? named : OTHER;
  const budgets: [Scope, Pair, string, { page: number; deep: number }][] = [
    ["address", state.address, bucketOf(clientAddress(request)), CRAWL_BUDGET],
    ["agent", state.agent, agent, AGENT_BUDGET],
    ["shared", state.shared, "all", SHARED_BUDGET],
  ];
  const taken: { limiter: RateLimiter; key: string }[] = [];
  for (const [scope, pair, key, budget] of budgets) {
    pair.page.setLimits(scaled(budget.page));
    pair.deep.setLimits(scaled(budget.deep));
    const counted = deep ? [pair.page, pair.deep] : [pair.page];
    for (const limiter of counted) {
      const v = limiter.take(key, "ro");
      if (v.allowed) {
        taken.push({ limiter, key });
        continue;
      }
      // A refused request spends nothing anywhere: give back what it took.
      for (const t of taken) t.limiter.refund(t.key);
      if (state.refused.has(agent) || state.refused.size < MAX_AGENTS)
        state.refused.set(agent, (state.refused.get(agent) ?? 0) + 1);
      state.refusedBy[scope]++;
      return { retryAfter: v.retryAfter, agent, scope };
    }
  }
  return undefined;
}

/**
 * A browser-looking reader with no session and no token, on a deep page:
 * counted per address, divided while the loop is behind, refused before any
 * page work (#8199). The explorer's lazy folder expansion
 * (`?fragment=explorer`) is a click, not a page, and is not counted.
 */
function takeStrangerDeep(app: App, request: Request, pathname: string): CrawlVerdict | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  if (!DEEP.test(pathname)) return undefined;
  if (new URL(request.url).searchParams.get("fragment") === "explorer") return undefined;
  watchLag();
  const state = stateOf(app);
  const behind = state.clock.pinned ?? (state.clock.behind || mainThreadBehind() || strangersQueued(state));
  const scale = behind ? BEHIND_DIVISOR : 1;
  state.strangerAddress.setLimits(limits(Math.max(1, Math.floor(STRANGER_BUDGET.address / scale))));
  const key = bucketOf(clientAddress(request));
  const own = state.strangerAddress.take(key, "ro");
  const all = own.allowed && behind ? state.strangerAll.take("all", "ro") : own;
  if (all.allowed) {
    state.strangersInFlight.set(request, state.clock.now());
    return undefined;
  }
  if (own.allowed) state.strangerAddress.refund(key);
  state.refusedBy.stranger++;
  return { retryAfter: all.retryAfter, agent: "browser", scope: "stranger" };
}

/**
 * Whether strangers' deep pages are queued past their share: at least
 * `inFlight` unanswered and the oldest waiting `queuedMs`. Any too old to be
 * real are forgotten first. The map keeps arrival order, so the first entry
 * is the oldest.
 */
function strangersQueued(state: State): boolean {
  const open = state.strangersInFlight;
  if (open.size < STRANGER_BUDGET.inFlight) return false;
  const now = state.clock.now();
  for (const [request, at] of open) {
    if (at >= now - IN_FLIGHT_MAX_MS) break;
    open.delete(request);
  }
  if (open.size < STRANGER_BUDGET.inFlight) return false;
  const first = open.values().next();
  return !first.done && now - first.value >= STRANGER_BUDGET.queuedMs;
}

/** The server has answered this request: if it was a stranger's deep page, it no longer counts as queued. */
export const finishedStrangerDeep = (app: App, request: Request): void => {
  stateOf(app).strangersInFlight.delete(request);
};

/** Requests refused so far in this process, by agent, most first. */
export const crawlRefusals = (app: App): { agent: string; refused: number }[] =>
  [...stateOf(app).refused]
    .map(([agent, refused]) => ({ agent, refused }))
    .sort((a, b) => b.refused - a.refused);

/** How many agent names the limiters track, for the test of the bound. */
export const crawlAgentCount = (app: App): number => stateOf(app).agent.page.size;

/** How many refusals each budget has given, for the board. */
export const crawlRefusalScopes = (app: App): Record<Scope, number> => ({ ...stateOf(app).refusedBy });

/** The refusal: small, plain, and not worth caching past the wait. */
export function crawlRefused(verdict: CrawlVerdict): Response {
  const words =
    verdict.scope === "stranger"
      ? "The forge is busy. Try again in a moment, or sign in to go straight through.\n"
      : "Too many requests from this crawler: see /robots.txt for what to skip.\n";
  return new Response(words, {
    status: 429,
    headers: {
      "retry-after": String(verdict.retryAfter),
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** The Shield's answer to an anonymous deep read: small, plain, and no page work. */
export function shieldRefused(signIn: string): Response {
  const words = `<!doctype html><meta charset="utf-8"><title>Sign in to read this</title>
<h1>Sign in to read this page</h1>
<p>The forge is asking visitors to sign in for now. <a href="${Bun.escapeHTML(signIn)}">Sign in</a> to go straight through.</p>
`;
  return new Response(words, {
    status: 503,
    headers: {
      "retry-after": "300",
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const shielded = new WeakSet<Request>();
/** The Shield turned this request away: a refusal on the traffic board, though it answers 503. */
export const noteShielded = (request: Request): void => void shielded.add(request);
export const wasShielded = (request: Request): boolean => shielded.has(request);

const noted = new WeakSet<Request>();
/** The server says this request was a crawler's, for the usage count and the performance record. */
export const noteCrawler = (request: Request): void => void noted.add(request);
export const wasCrawler = (request: Request): boolean => noted.has(request);

const notedDeep = new WeakSet<Request>();
/** The server says this was a browser-looking stranger's read of a deep page, for the crawler board. */
export const noteDeepStranger = (request: Request): void => void notedDeep.add(request);
export const wasDeepStranger = (request: Request): boolean => notedDeep.has(request);
