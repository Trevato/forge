/**
 * The website specification as a report (#2915, checks 1, 2 and 7). `webspec()`
 * fetches each path of a site once and returns what the page's head and
 * response headers get wrong, each finding citing its specification.website
 * section. It reports; it never throws on a bad page and never fails a run.
 * The HTML is read with small regexes, one function per check.
 */

export interface Finding {
  path: string;
  check: string;
  message: string;
  /** The specification.website section this finding cites. */
  section: string;
  /** Set when the CDN or edge in front of the app may own the header. */
  edge?: true;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
type Problem = { check: string; message: string; section: string; edge?: true };

const TIMEOUT_MS = 10000;
const SPEC = "https://specification.website/";
const s = (name: string) => `${SPEC}#${name}`;

const tags = (html: string, name: string): string[] => html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) ?? [];

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|[\\s"'/])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : undefined;
}

const metas = (html: string) => tags(html, "meta");
const metaBy = (html: string, key: "name" | "property", value: string) =>
  metas(html).filter((t) => attr(t, key)?.toLowerCase() === value);
const metaContent = (html: string, key: "name" | "property", value: string) =>
  metaBy(html, key, value)[0] && (attr(metaBy(html, key, value)[0]!, "content") ?? "");
const links = (html: string, rel: string) =>
  tags(html, "link").filter((t) => (attr(t, "rel") ?? "").toLowerCase().split(/\s+/).includes(rel));

export function headProblems(html: string): Problem[] {
  const out: Problem[] = [];
  const add = (check: string, message: string, section: string) => out.push({ check, message, section: s(section) });
  if (!/^\s*<!doctype html>/i.test(html)) add("doctype", "the page does not start with <!doctype html>", "doctype");
  const htmlTag = tags(html, "html")[0] ?? "";
  if (!(attr(htmlTag, "lang") ?? "").trim()) add("lang", "<html> has no lang attribute", "lang");
  const charset = metas(html).some(
    (t) => /^utf-8$/i.test(attr(t, "charset") ?? "") || (/content-type/i.test(attr(t, "http-equiv") ?? "") && /utf-8/i.test(attr(t, "content") ?? "")),
  );
  if (!charset) add("charset", 'no <meta charset="utf-8">', "charset");
  const viewport = metaContent(html, "name", "viewport");
  if (viewport === undefined) add("viewport", "no viewport meta", "viewport");
  else if (/maximum-scale\s*=|user-scalable\s*=\s*(no|0)/i.test(viewport))
    add("viewport", "the viewport locks zoom (maximum-scale or user-scalable=no)", "viewport");
  const titles = html.match(/<title\b[^>]*>/gi)?.length ?? 0;
  if (titles !== 1) add("title", `expected exactly one <title>, found ${titles}`, "title");
  if (!(metaContent(html, "name", "description") ?? "").trim()) add("description", "no meta description", "description");
  const canonical = links(html, "canonical").map((t) => attr(t, "href") ?? "")[0];
  const ogUrl = metaContent(html, "property", "og:url");
  if (!canonical) add("canonical", 'no <link rel="canonical">', "canonical");
  else if (canonical !== ogUrl) add("canonical", `canonical (${canonical}) is not og:url (${ogUrl ?? "missing"})`, "canonical");
  const themes = metaBy(html, "name", "theme-color").map((t) => attr(t, "media") ?? "");
  const has = (scheme: string) => themes.some((m) => m.replace(/\s+/g, "").includes(`prefers-color-scheme:${scheme}`));
  if (!has("light") || !has("dark")) add("theme-color", "theme-color needs a light and a dark variant (media=prefers-color-scheme)", "theme-color");
  if (!(metaContent(html, "name", "color-scheme") ?? "").trim()) add("color-scheme", "no color-scheme meta", "color-scheme");
  for (const p of ["og:title", "og:type", "og:url", "og:description", "og:image"])
    if (!(metaContent(html, "property", p) ?? "").trim()) add("open-graph", `missing ${p}`, "open-graph");
  return out;
}

/** Targets the head points at that must resolve: icons and the manifest. */
export function headTargets(html: string, pageUrl: string): { urls: string[]; bad: string[] } {
  const hrefs = [...links(html, "icon"), ...links(html, "apple-touch-icon"), ...links(html, "manifest")].map((t) => attr(t, "href") ?? "");
  const urls: string[] = [];
  const bad: string[] = [];
  for (const h of hrefs) {
    try {
      const u = new URL(h, pageUrl).href;
      if (!urls.includes(u)) urls.push(u);
    } catch {
      bad.push(h);
    }
  }
  return { urls, bad };
}

export function headerProblems(h: Headers, https: boolean): Problem[] {
  const out: Problem[] = [];
  const add = (check: string, message: string, section: string, edge?: true) =>
    out.push({ check, message, section: s(section), ...(edge ? { edge } : {}) });
  const csp = h.get("content-security-policy");
  if (!csp) add("csp", "no Content-Security-Policy", "csp");
  else {
    if (/'unsafe-eval'/i.test(csp)) add("csp", "CSP allows 'unsafe-eval'", "csp");
    const directives = csp.split(";").map((d) => d.trim());
    const script = directives.find((d) => /^script-src(-elem)?\s/i.test(d)) ?? directives.find((d) => /^default-src\s/i.test(d));
    if (script && /'unsafe-inline'/i.test(script)) add("csp", "CSP allows 'unsafe-inline' scripts", "csp");
    if (!directives.some((d) => /^frame-ancestors\s/i.test(d))) add("frame-ancestors", "CSP has no frame-ancestors", "frame-ancestors");
  }
  if ((h.get("x-content-type-options") ?? "").toLowerCase() !== "nosniff") add("nosniff", "X-Content-Type-Options is not nosniff", "nosniff");
  if (!h.get("referrer-policy")) add("referrer-policy", "no Referrer-Policy", "referrer-policy");
  if (!h.get("permissions-policy")) add("permissions-policy", "no Permissions-Policy", "permissions-policy");
  if (https && !h.get("strict-transport-security")) add("hsts", "no Strict-Transport-Security on an https URL", "hsts", true);
  if (h.has("x-xss-protection")) add("x-xss-protection", "X-XSS-Protection is set; drop it", "x-xss-protection");
  if (/\bimmutable\b/i.test(h.get("cache-control") ?? "")) add("cache-html", "HTML is cached immutable; only hashed assets may be", "caching");
  return out;
}

const COMPRESS_MIN = 1024;
const ACCEPT_ENCODING = "br, gzip";

/** The stylesheets the head links, as absolute URLs. */
function stylesheetTargets(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  for (const t of links(html, "stylesheet")) {
    try {
      const u = new URL(attr(t, "href") ?? "", pageUrl).href;
      if (!out.includes(u)) out.push(u);
    } catch {}
  }
  return out;
}

/** A text body big enough to be worth it must leave encoded, and say it varies. */
export function encodingProblems(h: Headers, bodyBytes: number): Problem[] {
  if (bodyBytes < COMPRESS_MIN) return [];
  const out: Problem[] = [];
  const encoding = (h.get("content-encoding") ?? "").toLowerCase();
  if (encoding !== "br" && encoding !== "gzip")
    out.push({ check: "compression", message: `a ${bodyBytes}-byte body was sent without br or gzip though Accept-Encoding: ${ACCEPT_ENCODING}`, section: SPEC, edge: true });
  else if (!/accept-encoding/i.test(h.get("vary") ?? "")) out.push({ check: "compression", message: "a compressed response has no Vary: Accept-Encoding", section: SPEC, edge: true });
  return out;
}

/** Fetches `paths` of `base` and reports head and header findings. */
export async function webspec(base: string, paths: string[], fetcher: Fetcher = fetch): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const path of paths) {
    const report = (ps: Problem[]) => {
      for (const p of ps) findings.push({ path, ...p });
    };
    let url: string;
    try {
      url = new URL(path, base).href;
    } catch {
      report([{ check: "fetch", message: `${path} is not a URL`, section: SPEC }]);
      continue;
    }
    let res: Response;
    let html: string;
    let htmlBytes = 0;
    try {
      res = await fetcher(url, { headers: { accept: "text/html", "accept-encoding": ACCEPT_ENCODING }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      html = await res.text();
      htmlBytes = new TextEncoder().encode(html).length;
    } catch (e) {
      report([{ check: "fetch", message: `could not fetch ${url}: ${e instanceof Error ? e.message : String(e)}`, section: SPEC }]);
      continue;
    }
    if (!res.ok) {
      report([{ check: "fetch", message: `${url} answered ${res.status}`, section: SPEC }]);
      continue;
    }
    report(headProblems(html));
    report(encodingProblems(res.headers, htmlBytes));
    for (const sheet of stylesheetTargets(html, url)) {
      try {
        const r = await fetcher(sheet, { headers: { "accept-encoding": ACCEPT_ENCODING }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        const size = new TextEncoder().encode(await r.text()).length;
        if (r.ok) report(encodingProblems(r.headers, size).map((p) => ({ ...p, message: `${sheet}: ${p.message}` })));
      } catch {}
    }
    const { urls, bad } = headTargets(html, url);
    for (const h of bad) report([{ check: "head-links", message: `"${h}" is not a URL`, section: s("icons") }]);
    for (const target of urls) {
      const status = await fetcher(target, { signal: AbortSignal.timeout(TIMEOUT_MS) }).then(
        async (r) => (await r.body?.cancel(), r.status),
        () => 0,
      );
      if (status < 200 || status >= 300) report([{ check: "head-links", message: `${target} answered ${status || "nothing"}`, section: s("icons") }]);
    }
    report(headerProblems(res.headers, new URL(url).protocol === "https:"));
    const etag = res.headers.get("etag");
    if (!etag) report([{ check: "etag", message: "no ETag on the HTML", section: s("caching") }]);
    else {
      const again = await fetcher(url, { headers: { accept: "text/html", "if-none-match": etag }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) }).then(
        async (r) => (await r.body?.cancel(), r.status),
        () => 0,
      );
      if (again !== 304) report([{ check: "etag", message: `If-None-Match answered ${again || "nothing"}, not 304`, section: s("caching") }]);
    }
  }
  return findings;
}
