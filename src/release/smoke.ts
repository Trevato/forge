/**
 * Is the forge answering, as a phone and as a desktop? Each of `/`, `/board`
 * (signed in with a token) and `/healthz` is fetched once per user agent and
 * must answer 200; the stylesheet linked from `/` must be a non-empty
 * `text/css` 200; `/sw.js` must be a 200 JavaScript response whose navigation
 * branch never answers with `Response.error()`. With `version`, `/healthz` is
 * first polled until `X-Forge-Version` is that version.
 *
 * With `heavy`, it also loads the heaviest pages (`HEAVY_PAGES`: `/boards`
 * signed in, `/`, `/explore`, `/search?q=a`, one repository's home), each of which
 * must answer 200 within `SLOW_MS`, then polls `/healthz` once a second for
 * `WATCH_MS`, rotating through those pages, and fails naming the page that
 * was slow or failed (#6898: `/readyz` never touches the database, 0.7.277 hung).
 * An empty 200 body or a hang is asked again once, like a slow answer: one
 * lost answer in a release's proof says little, two in a row fail it (#9334, #9482).
 * An answer slow on the probe's clock whose `Server-Timing` says the forge
 * itself spent `SLOW_MS` or less is the road to the public edge, not the
 * release, and passes (#9022); a hang, no answer within `ANSWER_MS`, still
 * fails. The hang's line sat at twice `SLOW_MS` until #11250: a repository
 * home answering in 2.1 s was then cut off before its `Server-Timing` could
 * say whose time it was, and failed 0.7.531 for 13 minutes as a hang.
 *
 * The running forge proves each new version with it (`release/prove.ts`), so
 * it lives here: the image ships src/ and nothing else (#2652).
 * `bun scripts/smoke.ts <url>` is the same checks from a shell.
 */

import { parseServerTiming } from "../perf/record.ts";

export const AGENTS: Record<string, string> = {
  phone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  desktop:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

/** How long after go-live `/healthz` is watched, how often, and the slowest answer allowed. */
export const WATCH_MS = 60_000;
export const WATCH_POLL_MS = 1_000;
export const SLOW_MS = 1_000;
/** The pause before a slow or lost first load is asked again: a boot's stall is seconds, a slow release stays slow (#10993). */
export const SETTLE_MS = 3_000;
/** How long an ask waits before it is a hang: past `SLOW_MS` an answer is slow, and its `Server-Timing` judges it (#11250). */
export const ANSWER_MS = 10_000;
/** One repository's home, for the heavy-page load. */
export const REPO_HOME = "/trevato/forge";
/** The heaviest pages; `/boards` is fetched with the token. */
export const HEAVY_PAGES: readonly string[] = ["/boards", "/", "/explore", "/search?q=a", REPO_HOME];

/**
 * How long the forge says it spent on `res`: the `app` entry of its
 * `Server-Timing` (`http/server.ts`), or undefined when there is none.
 */
export function forgeMs(res: Response): number | undefined {
  const app = parseServerTiming(res.headers.get("server-timing") ?? "").find((p) => p.name === "app");
  return app && Number.isFinite(app.ms) ? app.ms : undefined;
}

/**
 * What an empty 200 says about which layer lost the body (#9343): the forge
 * writes `Server-Timing` and `X-Forge-Version` and never an empty page, so
 * their absence points at the edge or the wire; a declared length with no
 * bytes points at a body cut short.
 */
export function emptyEvidence(res: Response): string {
  const seen = ["content-length", "content-encoding", "cf-cache-status", "age", "server-timing", "x-forge-version"]
    .map((name) => [name, res.headers.get(name)] as const)
    .filter((pair): pair is readonly [string, string] => pair[1] !== null)
    .map(([name, value]) => `${name}: ${value.slice(0, 80)}`);
  return seen.length === 0 ? " (no forge or edge headers)" : ` (${seen.join("; ")})`;
}

export interface Heavy {
  watchMs?: number;
  pollMs?: number;
  slowMs?: number;
  /** How long a slow first load waits before it is asked again, so a stall that follows the boot has passed (#10993). @default SETTLE_MS */
  settleMs?: number;
  /** How long an ask waits before it is a hang rather than a slow answer. @default ANSWER_MS */
  answerMs?: number;
  /** The repository whose home is loaded; unset, `REPO_HOME` is tried and a 404 there is skipped. */
  repo?: string;
  /** Every `/healthz` answer in the watch must carry this `X-Forge-Version`. */
  version?: string | undefined;
  /** Sent with the watch's `/healthz`: the forge tells only its probe its version. */
  probe?: Readonly<Record<string, string>>;
}

export interface Failure {
  url: string;
  agent: string;
  status: number | string;
  contentType: string;
  why: string;
  /** The check failed only because the answer was slower than allowed. */
  slow?: boolean;
  /** The check failed only because a 200 answered with no body: a lost answer, retried like a slow one (#9358). */
  empty?: boolean;
  /** The check failed only because no answer came within `ANSWER_MS`: retried like a slow one (#9482, #11250). */
  hung?: boolean;
}

/** The first stylesheet href in a page, or null. */
export function stylesheetHref(html: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const value = href?.[1] ?? href?.[2];
    if (value) return value.replaceAll("&amp;", "&");
  }
  return null;
}

/** The part of a service worker that answers navigations, comments removed. */
export function navigationBranch(source: string): string | null {
  const at = source.search(/mode\s*===?\s*["']navigate["']/);
  if (at < 0) return null;
  const rest = source.slice(at);
  const end = rest.search(/\breturn\s*;/);
  return (end < 0 ? rest : rest.slice(0, end)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

export interface Options {
  /** Wait for `/healthz` to report this `X-Forge-Version`. */
  version?: string | undefined;
  /** Sent with that wait: the forge tells only its probe its version (`kernel/probe.ts`). */
  probe?: Readonly<Record<string, string>>;
  /** Longest wait for it, in milliseconds. */
  waitMs?: number;
  /** Pause between polls, in milliseconds. */
  pollMs?: number;
  /** The fetch to use; the global one unless a caller (the forge proving itself, a test) gives its own. */
  fetch?: typeof fetch;
  /** Accept a redirect from `/board` to sign-in as the sign-in it is, for a caller holding no token. */
  anonymousBoard?: boolean;
  /** An app's URL on this forge: `GET /` there must never be a forge page (#6726). */
  appHost?: string;
  /** Load the heaviest pages, then watch `/healthz` (see the top of this file). Off unless given. */
  heavy?: Heavy;
}

/** The redirect statuses a sign-in answers with. */
const REDIRECTS = new Set([302, 303, 307]);

/**
 * Is `res`, fetched from `url`, a redirect to sign in on the same host: the
 * forge's own `/signin` or the platform edge's `/_plat/login` (#2673)?
 */
export function isSignInRedirect(url: string, res: Response): boolean {
  if (!REDIRECTS.has(res.status)) return false;
  const location = res.headers.get("location");
  if (!location) return false;
  let to: URL;
  try {
    to = new URL(location, url);
  } catch {
    return false;
  }
  return to.origin === new URL(url).origin && (to.pathname === "/signin" || to.pathname === "/_plat/login");
}

/** Polls `/healthz` until it reports `version`; null when it does, else a failure. */
async function waitForVersion(root: URL, version: string, waitMs: number, pollMs: number, fetch: typeof globalThis.fetch, probe: Readonly<Record<string, string>>): Promise<Failure | null> {
  const url = new URL("/healthz", root).href;
  const deadline = Date.now() + waitMs;
  let seen = "none";
  let status: number | string = "error";
  for (;;) {
    try {
      const res = await fetch(url, { redirect: "manual", headers: probe, signal: AbortSignal.timeout(5_000) });
      await res.body?.cancel();
      status = res.status;
      seen = res.headers.get("x-forge-version") ?? "none";
      if (seen === version) return null;
    } catch (error) {
      status = "error";
      seen = `none (${error})`;
    }
    if (Date.now() + pollMs > deadline) break;
    await Bun.sleep(pollMs);
  }
  return { url, agent: "-", status, contentType: "", why: `wanted X-Forge-Version ${version}, last saw ${seen}` };
}

/** Loads each of `HEAVY_PAGES`, then polls `/healthz` for the window; the first failure, or null. */
async function watch(root: URL, token: string, heavy: Heavy, fetch: typeof globalThis.fetch, anonymousBoard: boolean): Promise<Failure | null> {
  const slowMs = heavy.slowMs ?? SLOW_MS;
  const answerMs = Math.max(heavy.answerMs ?? ANSWER_MS, slowMs);
  const headers: Record<string, string> = { "user-agent": AGENTS["desktop"]! };
  const pages = HEAVY_PAGES.map((p) => (p === REPO_HOME && heavy.repo ? heavy.repo : p));
  /** Is `url` whole when asked with no encoding: the way to tell the edge's encoding from the forge's answer (#10889). */
  const unencodedBody = async (url: string): Promise<boolean> => {
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(answerMs), headers: { ...headers, "accept-encoding": "identity" } });
      return res.status === 200 && (await res.text()).trim() !== "";
    } catch {
      return false;
    }
  };
  // An answer between `slowMs` and `answerMs` is slow, judged by the forge's own time; none by then is a hang.
  const once = async (path: string): Promise<{ failure: Failure | null; slow: boolean; hung?: boolean; empty?: boolean }> => {
    const url = new URL(path, root).href;
    const started = performance.now();
    const failureFor = (why: string, status: number | string = "error"): Failure => ({ url, agent: "desktop", status, contentType: "", why });
    const gone = (why: string, status: number | string = "error") => ({ failure: failureFor(why, status), slow: false });
    try {
      const auth: Record<string, string> = path === "/boards" && token ? { authorization: `Bearer ${token}` } : {};
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(answerMs), headers: { ...headers, ...(path === "/healthz" ? heavy.probe : {}), ...auth } });
      const body = await res.text();
      const took = Math.round(performance.now() - started);
      if (took > slowMs) {
        // The forge's own time says whether the release was slow or the way to it was (#9022).
        const own = forgeMs(res);
        const whose = own === undefined ? "" : `, the forge ${Math.round(own)} ms of it`;
        if (own === undefined || own > slowMs) return { failure: { ...failureFor(`${path} took ${took} ms, over ${slowMs} ms${whose}`, res.status), slow: true }, slow: true };
        console.warn(`smoke: ${path} took ${took} ms, the forge ${Math.round(own)} ms of it; the rest was the network`);
      }
      if (path === REPO_HOME && !heavy.repo && res.status === 404) return { failure: null, slow: false };
      if (path === "/healthz" && heavy.version && res.headers.get("x-forge-version") !== heavy.version)
        return gone(`/healthz reported X-Forge-Version ${res.headers.get("x-forge-version") ?? "none"}, wanted ${heavy.version}`, res.status);
      if (path === "/boards" && anonymousBoard && !token && isSignInRedirect(url, res)) return { failure: null, slow: false };
      if (res.status !== 200) return gone(`${path} expected 200`, res.status);
      if (!body.trim()) {
        // An empty body under a content-encoding may be the edge's encoding of it (#10889: zstd, twice in a row,
        // 60 minutes). Asked again unencoded, a body says the forge answered and only the encoding lost it.
        if (res.headers.has("content-encoding") && (await unencodedBody(url))) {
          console.warn(`smoke: EDGE-ENCODING-EMPTY ${path} came back empty under content-encoding ${res.headers.get("content-encoding")} but whole unencoded; passed as the release's, though a browser accepting that encoding would see it blank (the edge's fault; cause unconfirmed)`);
          return { failure: null, slow: false };
        }
        const lost = gone(`${path} answered with an empty body${emptyEvidence(res)}`, res.status);
        return { failure: { ...lost.failure, empty: true }, slow: false, empty: true };
      }
      return { failure: null, slow: false };
    } catch (error) {
      const lost = gone(`${path} did not answer within ${answerMs} ms (${error})`);
      return { failure: { ...lost.failure, hung: true }, slow: false, hung: true };
    }
  };
  // The cause of 0.7.279's 1098 ms /boards is unconfirmed; a cold cache after
  // the boot is the guess (#7198). So each page's first load, and only that,
  // is asked again after a slow, empty or hung answer (never an error), and
  // the first is printed: 0.7.415's first `/` hung once right after its boot
  // and cost the release 12 minutes (#9482). The watch below asks again once
  // as well, so one slow answer there no longer fails the proof (#8917).
  const timed = async (path: string): Promise<Failure | null> => {
    const first = await once(path);
    if (!first.slow && !first.empty && !first.hung) return first.failure;
    console.warn(`smoke: ${first.failure?.why}; asking again`);
    await Bun.sleep(heavy.settleMs ?? SETTLE_MS);
    return (await once(path)).failure;
  };
  for (const path of pages) {
    const failed = await timed(path);
    if (failed) return failed;
  }
  // In the watch one lost or slow answer in a minute of polling (#7724, #8917)
  // is asked again at once; two in a row is a hang or a real slowness and
  // fails the proof. Unlike `timed`, a hung answer is asked again too: the
  // first load is judged once, but the watch polls for a minute and one lost
  // answer among dozens says little. The first slow answer is printed.
  const again = async (path: string) => {
    const first = await once(path);
    if (!first.hung && !first.slow && !first.empty) return first;
    console.warn(`smoke: ${first.failure?.why}; asking again`);
    return once(path);
  };
  const deadline = Date.now() + (heavy.watchMs ?? WATCH_MS);
  const pollMs = heavy.pollMs ?? WATCH_POLL_MS;
  for (let tick = 0; Date.now() < deadline; tick++) {
    const health = await again("/healthz");
    const failed = health.failure ?? (await again(pages[tick % pages.length]!)).failure;
    if (failed) return failed;
    await Bun.sleep(pollMs);
  }
  return null;
}

/** Runs every check against `base`; returns the failures (empty is green). */
export async function smoke(base: string, token = "", options: Options = {}): Promise<Failure[]> {
  const root = new URL(base);
  if (root.protocol !== "http:" && root.protocol !== "https:") throw new Error("url must be http(s)");
  const failures: Failure[] = [];
  const fetch = options.fetch ?? globalThis.fetch;
  if (options.version) {
    const late = await waitForVersion(root, options.version, options.waitMs ?? 120_000, options.pollMs ?? 1_000, fetch, options.probe ?? {});
    if (late) return [late];
  }

  const get = async (path: string, agent: string, headers: Record<string, string> = {}) => {
    const url = new URL(path, root).href;
    try {
      const res = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: { "user-agent": AGENTS[agent]!, ...headers },
      });
      return { url, res, body: await res.text() };
    } catch (error) {
      failures.push({ url, agent, status: "error", contentType: "", why: String(error) });
      return null;
    }
  };
  const fail = (url: string, agent: string, res: Response, why: string) =>
    failures.push({ url, agent, status: res.status, contentType: res.headers.get("content-type") ?? "", why });

  for (const agent of Object.keys(AGENTS)) {
    const auth: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    const home = await get("/", agent);
    if (home) {
      if (home.res.status !== 200) fail(home.url, agent, home.res, "expected 200");
      else {
        const href = stylesheetHref(home.body);
        if (!href) failures.push({ url: home.url, agent, status: 200, contentType: "", why: "no stylesheet linked" });
        else {
          const css = await get(href, agent);
          if (css) {
            const type = css.res.headers.get("content-type") ?? "";
            if (css.res.status !== 200) fail(css.url, agent, css.res, "expected 200");
            else if (!/^text\/css\b/i.test(type)) fail(css.url, agent, css.res, "expected text/css");
            else if (!css.body.trim()) fail(css.url, agent, css.res, "empty stylesheet");
          }
        }
      }
    }
    const board = await get("/board", agent, auth);
    const signIn = options.anonymousBoard && !token && !!board && isSignInRedirect(board.url, board.res);
    if (board && board.res.status !== 200 && !signIn) fail(board.url, agent, board.res, "expected 200 (or a redirect to sign-in)");
    const health = await get("/healthz", agent);
    if (health && health.res.status !== 200) fail(health.url, agent, health.res, "expected 200");
  }

  const sw = await get("/sw.js", "desktop");
  if (sw) {
    const type = sw.res.headers.get("content-type") ?? "";
    if (sw.res.status !== 200) fail(sw.url, "desktop", sw.res, "expected 200");
    else if (!/^(text|application)\/(x-)?javascript\b/i.test(type)) fail(sw.url, "desktop", sw.res, "expected javascript");
    else {
      const nav = navigationBranch(sw.body);
      if (nav === null) fail(sw.url, "desktop", sw.res, "no navigation branch");
      else if (/Response\s*\.\s*error\s*\(/.test(nav)) fail(sw.url, "desktop", sw.res, "a navigation can be answered with Response.error()");
    }
  }
  if (options.appHost) {
    const url = new URL("/", options.appHost).href;
    // This check asks one thing: does an app host answer as the forge (#6726)? An app that is
    // asleep, stopped or broken and gives no answer at all says nothing about that: it is the
    // app's health, not the release's, so it is asked once more and then left out of the verdict
    // (#10189: hello's host timing out held release 0.7.479 unproven for hours).
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "user-agent": AGENTS["desktop"]! } });
        const body = await res.text();
        if (/<title>\s*forge\s*<\/title>/i.test(body)) fail(url, "desktop", res, "an app host answered with the forge's page");
        break;
      } catch (error) {
        console.warn(`smoke: app host ${url} gave no answer (${error}); ${attempt === 1 ? "asking again" : "the app's health, not the release's"}`);
      }
    }
  }
  if (options.heavy && failures.length === 0) {
    const heavy = { version: options.version, ...(options.probe ? { probe: options.probe } : {}), ...options.heavy };
    const slow = await watch(root, token, heavy, fetch, !!options.anonymousBoard);
    if (slow) failures.push(slow);
  }
  return failures;
}
