/**
 * The website specification as a report (#2915, checks 1, 2, 5 and 7). `webspec()`
 * fetches each path of a site once and returns what the page's head and
 * response headers get wrong, and what the body's structure gets wrong, each finding citing its specification.website
 * section. It reports; it never throws on a bad page and never fails a run.
 * The HTML is read with small regexes, one function per check.
 */

import { siteFindings } from "./webspec-site.ts";

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
export const s = (name: string) => `${SPEC}#${name}`;

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

const HEADING = /<h([1-6])\b[^>]*>/gi;
const NO_LABEL_TYPES = new Set(["hidden", "submit", "button", "reset", "image"]);
/** A tag with its quoted values blanked, so attribute names can be read safely. */
const bare = (tag: string) => tag.replace(/"[^"]*"|'[^']*'/g, '""');
const text = (inner: string) => inner.replace(/<[^>]*>/g, "").replace(/&nbsp;|\s+/g, " ").trim();
const nonEmpty = (v: string | undefined) => (v ?? "").trim() !== "";

/** The body's structure: headings, names, labels, landmarks, handlers, scripts. */
export function bodyProblems(html: string, https: boolean): Problem[] {
  const out: Problem[] = [];
  const add = (check: string, message: string, section: string) => out.push({ check, message, section: s(section) });
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/(<(script|style)\b[^>]*>)[\s\S]*?<\/\2\s*>/gi, "$1</$2>");
  const bodyAt = clean.search(/<body\b/i);
  const body = bodyAt < 0 ? clean : clean.slice(bodyAt);

  let prev = 0;
  let h1 = 0;
  for (const m of body.matchAll(HEADING)) {
    const level = Number(m[1]);
    if (level === 1) h1++;
    if (level > prev + 1) add("headings", `<h${level}> follows ${prev ? `<h${prev}>` : "no heading"}; levels must not skip`, "headings");
    prev = level;
  }
  if (h1 !== 1) add("h1", `expected exactly one <h1>, found ${h1}`, "headings");

  for (const t of tags(body, "img")) if (attr(t, "alt") === undefined) add("img-alt", `<img> has no alt: ${attr(t, "src") ?? "no src"}`, "images");

  const labels = [...body.matchAll(/<label\b[^>]*>[\s\S]*?<\/label\s*>/gi)];
  const forIds = labels.map((l) => attr(l[0].match(/^<label\b[^>]*>/i)![0], "for")).filter(nonEmpty);
  for (const f of body.matchAll(/<(input|select|textarea)\b[^>]*>/gi)) {
    const t = f[0];
    if (f[1]!.toLowerCase() === "input" && NO_LABEL_TYPES.has((attr(t, "type") ?? "text").toLowerCase())) continue;
    const at = f.index!;
    const wrapped = labels.some((l) => at > l.index! && at < l.index! + l[0].length);
    const id = attr(t, "id");
    if (!wrapped && !(nonEmpty(id) && forIds.includes(id!)) && !nonEmpty(attr(t, "aria-label")) && !nonEmpty(attr(t, "aria-labelledby")))
      add("label", `<${f[1]!.toLowerCase()}${id ? ` id="${id}"` : attr(t, "name") ? ` name="${attr(t, "name")}"` : ""}> has no label`, "forms");
  }

  for (const m of body.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
    const open = `<${m[1]}${m[2]}>`;
    if (m[1]!.toLowerCase() === "a" && attr(open, "href") === undefined) continue;
    const imgAlt = tags(m[3]!, "img").some((i) => nonEmpty(attr(i, "alt")));
    if (!text(m[3]!) && !imgAlt && !nonEmpty(attr(open, "aria-label")) && !nonEmpty(attr(open, "aria-labelledby")) && !nonEmpty(attr(open, "title")))
      add("accessible-name", `<${m[1]!.toLowerCase()}${attr(open, "href") ? ` href="${attr(open, "href")}"` : ""}> has no accessible name`, "names");
  }

  const focusable = body.match(/<(a\b[^>]*\shref|button\b|input\b|select\b|textarea\b|[a-z0-9]+\b[^>]*\stabindex\s*=\s*["']?(?:0|[1-9]))[^>]*>/i);
  const first = focusable?.[0] ?? "";
  const href = /^<a\b/i.test(first) ? (attr(first, "href") ?? "") : "";
  if (focusable && !(href.startsWith("#") && href.length > 1)) add("skip-link", "the first focusable element is not a skip link (an in-page #target link)", "skip-link");

  const mains = (body.match(/<main\b/gi) ?? []).length;
  if (mains !== 1) add("main", `expected exactly one <main>, found ${mains}`, "landmarks");

  for (const m of body.matchAll(/<[a-z][^>]*>/gi))
    for (const h of bare(m[0]).matchAll(/[\s"'/](on[a-z]+)\s*=/gi)) add("inline-handler", `inline ${h[1]!.toLowerCase()} handler on ${m[0].slice(0, 60)}`, "csp");

  for (const t of tags(body, "script")) {
    if (attr(t, "src") === undefined) continue;
    const flags = bare(t);
    if (!/[\s"'/](defer|async)(?=[\s>/=]|$)/i.test(flags) && (attr(t, "type") ?? "").toLowerCase() !== "module")
      add("script-defer", `external script ${attr(t, "src")} is not defer, async or module`, "scripts");
  }

  if (https) {
    const refs = [...tags(clean, "link").filter((t) => !/\b(canonical|alternate|author)\b/i.test(attr(t, "rel") ?? "")).map((t) => attr(t, "href")),
      ...["img", "script", "iframe", "source", "video", "audio", "embed", "track"].flatMap((n) => tags(clean, n).map((t) => attr(t, "src")))];
    for (const r of refs) if (/^\s*http:\/\//i.test(r ?? "")) add("mixed-content", `http:// subresource on an https page: ${r}`, "https");
  }
  return out;
}

/** Targets the head points at that must resolve: icons and the manifest. */
export function headTargets(html: string, pageUrl: string): { urls: string[]; bad: string[] } {
  const hrefs = [...links(html, "icon"), ...links(html, "apple-touch-icon"), ...links(html, "manifest")].map((t) => attr(t, "href") ?? "");
  const urls: string[] = [];
  const bad: string[] = [];
  for (const h of hrefs) {
    try {
      const u = new URL(h, pageUrl);
      // A data: icon carries its own bytes; there is nothing to fetch.
      if (u.protocol === "data:") continue;
      if (!urls.includes(u.href)) urls.push(u.href);
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
  if (!h.get("cross-origin-opener-policy")) add("coop", "no Cross-Origin-Opener-Policy", "coop", true);
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

/**
 * Fetches `paths` of `base` and reports head and header findings. With
 * `opts.site` it also reports the well-known files and error pages, once for
 * the base (checks 3 and 4); `opts.errorPath` names a path that must answer 500.
 */
export async function webspec(base: string, paths: string[], fetcher: Fetcher = fetch, opts: { site?: boolean; errorPath?: string } = {}): Promise<Finding[]> {
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
    report(bodyProblems(html, new URL(url).protocol === "https:"));
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
  if (opts.site) findings.push(...(await siteFindings(base, fetcher, opts.errorPath ? { errorPath: opts.errorPath } : {})));
  return findings;
}
