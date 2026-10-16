/**
 * `bun scripts/smoke.ts <url>` — is the forge answering, as a phone and as a
 * desktop? Each of `/`, `/board` (signed in with `FORGE_TOKEN`) and
 * `/healthz` is fetched once per user agent and must answer 200; the
 * stylesheet linked from `/` must be a non-empty `text/css` 200. Exit 1 and
 * one line per failure (url, user agent, status, content type) otherwise.
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

/** Runs every check against `base`; returns the failures (empty is green). */
export async function smoke(base: string, token = ""): Promise<Failure[]> {
  const root = new URL(base);
  if (root.protocol !== "http:" && root.protocol !== "https:") throw new Error("url must be http(s)");
  const failures: Failure[] = [];

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
    if (board && board.res.status !== 200) fail(board.url, agent, board.res, "expected 200 (a 302 is sign-in)");
    const health = await get("/healthz", agent);
    if (health && health.res.status !== 200) fail(health.url, agent, health.res, "expected 200");
  }
  return failures;
}

if (import.meta.main) {
  const base = process.argv[2];
  if (!base) {
    console.error("usage: bun scripts/smoke.ts <url>");
    process.exit(2);
  }
  const failures = await smoke(base, process.env["FORGE_TOKEN"] ?? "");
  for (const f of failures)
    console.error(`FAIL ${f.url} agent=${f.agent} status=${f.status} content-type=${f.contentType || "-"} (${f.why})`);
  if (failures.length) process.exit(1);
  console.log(`smoke ok: ${base}`);
}
