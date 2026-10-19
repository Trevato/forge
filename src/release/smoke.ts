/**
 * Is the forge answering, as a phone and as a desktop? Each of `/`, `/board`
 * (signed in with a token) and `/healthz` is fetched once per user agent and
 * must answer 200; the stylesheet linked from `/` must be a non-empty
 * `text/css` 200; `/sw.js` must be a 200 JavaScript response whose navigation
 * branch never answers with `Response.error()`. With `version`, `/healthz` is
 * first polled until `X-Forge-Version` is that version.
 *
 * The running forge proves each new version with it (`release/prove.ts`), so
 * it lives here: the image ships src/ and nothing else (#2652).
 * `bun scripts/smoke.ts <url>` is the same checks from a shell.
 */

export const AGENTS: Record<string, string> = {
  phone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  desktop:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

export interface Failure {
  url: string;
  agent: string;
  status: number | string;
  contentType: string;
  why: string;
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
  /** Longest wait for it, in milliseconds. */
  waitMs?: number;
  /** Pause between polls, in milliseconds. */
  pollMs?: number;
  /** The fetch to use; the global one unless a caller (the forge proving itself, a test) gives its own. */
  fetch?: typeof fetch;
  /** Accept a redirect from `/board` as the sign-in it is, for a caller holding no token. */
  anonymousBoard?: boolean;
}

/** Polls `/healthz` until it reports `version`; null when it does, else a failure. */
async function waitForVersion(root: URL, version: string, waitMs: number, pollMs: number, fetch: typeof globalThis.fetch): Promise<Failure | null> {
  const url = new URL("/healthz", root).href;
  const deadline = Date.now() + waitMs;
  let seen = "none";
  let status: number | string = "error";
  for (;;) {
    try {
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
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

/** Runs every check against `base`; returns the failures (empty is green). */
export async function smoke(base: string, token = "", options: Options = {}): Promise<Failure[]> {
  const root = new URL(base);
  if (root.protocol !== "http:" && root.protocol !== "https:") throw new Error("url must be http(s)");
  const failures: Failure[] = [];
  const fetch = options.fetch ?? globalThis.fetch;
  if (options.version) {
    const late = await waitForVersion(root, options.version, options.waitMs ?? 120_000, options.pollMs ?? 1_000, fetch);
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
    const signIn = options.anonymousBoard && !token && board?.res.status === 302;
    if (board && board.res.status !== 200 && !signIn) fail(board.url, agent, board.res, "expected 200 (a 302 is sign-in)");
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
  return failures;
}
