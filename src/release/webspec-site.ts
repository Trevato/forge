/**
 * The website specification as a report (#2915, checks 3 and 4): the
 * well-known files a site answers once per base, and its error pages. Same
 * contract as `webspec.ts`: findings with a section, nothing thrown.
 */

import type { Finding } from "./webspec.ts";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
type Seen = { status: number; headers: Headers; text: string };

const TIMEOUT_MS = 10000;
/** The most sitemap URLs fetched, so a huge sitemap cannot make the report slow. */
export const SITEMAP_CAP = 50;
const s = (name: string) => `https://specification.website/#${name}`;
const SIGN_IN_SEGMENT = /^(sign-?in|log-?in|auth|sessions?)$/i;

/** Whether a redirect target is a sign-in page, judged by whole path segments so /authors is not one. */
function isSignIn(where: string, root: URL): boolean {
  try {
    return new URL(where, root).pathname.split("/").some((seg) => SIGN_IN_SEGMENT.test(seg));
  } catch {
    return false; // an unparsable Location is not a sign-in page
  }
}

export interface SiteOptions {
  /** A path that is meant to answer 500 with the custom page; 500 is checked only when named. */
  errorPath?: string;
}

async function see(fetcher: Fetcher, url: string, accept = "*/*", body = true): Promise<Seen | undefined> {
  try {
    const r = await fetcher(url, { headers: { accept }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!body) {
      await r.body?.cancel();
      return { status: r.status, headers: r.headers, text: "" };
    }
    return { status: r.status, headers: r.headers, text: await r.text() };
  } catch {
    return undefined;
  }
}

/** Whether a body is the app's own page: HTML with a <title> and a stylesheet. */
export function isOwnPage(r: Seen): boolean {
  const type = r.headers.get("content-type") ?? "";
  return /html/i.test(type) && /<title\b/i.test(r.text) && (/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i.test(r.text) || /<style\b/i.test(r.text));
}

export async function siteFindings(base: string, fetcher: Fetcher, opts: SiteOptions = {}): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (path: string, check: string, message: string, section: string) => out.push({ path, check, message, section: s(section) });
  let root: URL;
  try {
    root = new URL(base);
  } catch {
    return [{ path: "/", check: "fetch", message: `${base} is not a URL`, section: "https://specification.website/" }];
  }
  const at = (p: string) => new URL(p, root).href;
  const ok = (r?: Seen) => !!r && r.status >= 200 && r.status < 300;

  // robots.txt and the sitemap it names
  const robots = await see(fetcher, at("/robots.txt"));
  if (!ok(robots)) add("/robots.txt", "robots", `/robots.txt answered ${robots?.status ?? "nothing"}`, "robots");
  else {
    const line = /^sitemap:[ \t]*(\S+)/im.exec(robots!.text);
    if (!line) add("/robots.txt", "robots", "robots.txt has no Sitemap: line", "robots");
    else {
      let map: URL | undefined;
      try {
        map = new URL(line[1]!, root);
      } catch {
        map = undefined; // reported below as not on this site
      }
      if (!map || map.origin !== root.origin) add("/robots.txt", "sitemap", `Sitemap: ${line[1]} is not on this site`, "sitemap");
      else {
        const sm = await see(fetcher, map.href);
        if (!ok(sm)) add(map.pathname, "sitemap", `${map.href} answered ${sm?.status ?? "nothing"}`, "sitemap");
        else {
          const locs = [...sm!.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!.replace(/&amp;/g, "&"));
          for (const loc of locs.slice(0, SITEMAP_CAP)) {
            let u: URL;
            try {
              u = new URL(loc, root);
            } catch {
              continue;
            }
            if (u.origin !== root.origin) continue;
            const r = await see(fetcher, u.href, "text/html", false);
            if (!r) continue;
            const where = r.headers.get("location") ?? "";
            if (r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400 && isSignIn(where, root)))
              add(map.pathname, "sitemap", `${u.href} is listed but answers ${r.status}${where ? ` to ${where}` : ""} for an anonymous fetch`, "sitemap");
          }
        }
      }
    }
  }

  // security.txt
  const sec = await see(fetcher, at("/.well-known/security.txt"));
  if (!ok(sec)) add("/.well-known/security.txt", "security-txt", `security.txt answered ${sec?.status ?? "nothing"}`, "security-txt");
  else {
    const exp = /^expires:[ \t]*(\S+)/im.exec(sec!.text);
    const when = exp ? Date.parse(exp[1]!) : NaN;
    if (!exp) add("/.well-known/security.txt", "security-txt", "security.txt has no Expires:", "security-txt");
    else if (!(when > Date.now())) add("/.well-known/security.txt", "security-txt", `security.txt Expires: ${exp[1]} is not in the future`, "security-txt");
  }

  // manifest: the one the home page links, else the conventional name
  const home = await see(fetcher, at("/"), "text/html");
  const link = home && /<link\b[^>]*\brel\s*=\s*["']?manifest\b[^>]*>/i.exec(home.text)?.[0];
  const href = link && /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(link);
  const manifestUrl = at(href ? (href[1] ?? href[2] ?? "/manifest.webmanifest") : "/manifest.webmanifest");
  const man = await see(fetcher, manifestUrl);
  if (!ok(man)) add("/manifest", "manifest", `${manifestUrl} answered ${man?.status ?? "nothing"}`, "manifest");
  else {
    let j: unknown;
    try {
      j = JSON.parse(man!.text);
    } catch {
      j = undefined; // reported below as not a JSON object
    }
    const o = j && typeof j === "object" ? (j as Record<string, unknown>) : undefined;
    if (!o) add("/manifest", "manifest", "the manifest is not a JSON object", "manifest");
    else {
      if (typeof o["name"] !== "string" || !o["name"].trim()) add("/manifest", "manifest", "the manifest has no name", "manifest");
      if (!Array.isArray(o["icons"]) || o["icons"].length === 0) add("/manifest", "manifest", "the manifest has no icons", "manifest");
    }
  }

  // llms.txt and change-password
  const llms = await see(fetcher, at("/llms.txt"));
  if (!ok(llms)) add("/llms.txt", "llms-txt", `/llms.txt answered ${llms?.status ?? "nothing"}`, "llms-txt");
  const pw = await see(fetcher, at("/.well-known/change-password"));
  if (!pw || pw.status < 300 || pw.status >= 400 || !pw.headers.get("location"))
    add("/.well-known/change-password", "change-password", `change-password did not redirect (${pw?.status ?? "nothing"})`, "change-password");

  // error pages
  const missing = `/__webspec-${crypto.randomUUID().replace(/-/g, "")}`;
  const nf = await see(fetcher, at(missing), "text/html");
  if (!nf) add(missing, "error-404", "a random path did not answer", "error-pages");
  else {
    if (nf.status !== 404) add(missing, "error-404", `a random path answered ${nf.status}, not 404`, "error-pages");
    if (!isOwnPage(nf)) add(missing, "error-404", "the 404 body is not the app's own HTML page (title and stylesheet)", "error-pages");
  }
  if (opts.errorPath) {
    const e = await see(fetcher, at(opts.errorPath), "text/html");
    if (!e) add(opts.errorPath, "error-500", "the error path did not answer", "error-pages");
    else {
      if (e.status !== 500) add(opts.errorPath, "error-500", `the error path answered ${e.status}, not 500`, "error-pages");
      if (!isOwnPage(e)) add(opts.errorPath, "error-500", "the 500 body is not the app's own HTML page (title and stylesheet)", "error-pages");
    }
  }
  return out;
}
