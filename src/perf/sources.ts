/**
 * What a page view says about where it came from, reduced to what may be kept:
 * the referrer's host (never its path or query), the three `utm_` fields, and
 * the host of an outbound link, kept only when it is in the named set. Plain
 * strings in, plain data out; every value is bounded and restricted to a
 * safe alphabet, so what is stored is also safe to print.
 */

/** The links whose clicks are counted. A host matches itself and its subdomains. */
export const OUTBOUND_DEFAULT = ["github.com", "espodev.com"] as const;

/** The named set: the default, or `FORGE_OUTBOUND_LINKS` (comma-separated hosts) when it is set. */
export function outboundNames(env: Record<string, string | undefined> = process.env): readonly string[] {
  const given = (env["FORGE_OUTBOUND_LINKS"] ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => HOST.test(h));
  return given.length > 0 ? given : OUTBOUND_DEFAULT;
}

const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const TAG = /^[a-z0-9][a-z0-9._ -]{0,63}$/;
const HEADLESS = /headless|puppeteer|playwright|phantomjs|selenium|python-requests|curl\/|wget|go-http|okhttp|java\/|libwww|httpclient|axios|node-fetch|undici/i;
const CRAWLER = /bot\b|bot[/ ;)-]|crawl|spider|slurp|scrap|archiver|reflection|facebookexternalhit|bingpreview|ia_archiver/i;

/** A User-Agent that is a program, not a person: a crawler, a headless browser, an HTTP library, or none. */
export const isScraperAgent = (userAgent: string): boolean =>
  userAgent.length === 0 || CRAWLER.test(userAgent.slice(0, 300)) || HEADLESS.test(userAgent.slice(0, 300));

/** A host as it may be kept, or "": lowercase, no `www.`, letters, digits, dots and hyphens. */
export function hostOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  return HOST.test(host) ? host : "";
}

const tag = (value: string | null): string => {
  const v = (value ?? "").trim().toLowerCase();
  return TAG.test(v) ? v : "";
};

/** The named link a clicked host belongs to, or "". */
export function outboundOf(host: string, names: readonly string[] = outboundNames()): string {
  const h = host.toLowerCase().replace(/^www\./, "");
  if (!HOST.test(h)) return "";
  return names.find((n) => h === n || h.endsWith(`.${n}`)) ?? "";
}

export interface Origin {
  readonly refHost: string;
  readonly source: string;
  readonly medium: string;
  readonly campaign: string;
  readonly out: string;
}

/**
 * `referrer` is document.referrer, `search` is location.search, `own` the host
 * the page was served from (a referrer from the same host is navigation inside
 * the site, not a source), `clicked` the host of the link the visitor left by.
 */
export function originOf(
  referrer: string | undefined,
  search: string | undefined,
  own: string,
  clicked: string | undefined,
  names: readonly string[] = outboundNames(),
): Origin {
  const params = new URLSearchParams(search ?? "");
  const ref = referrer ? hostOf(referrer) : "";
  const external = ref !== "" && ref !== own.toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "");
  const utm = tag(params.get("utm_source"));
  return {
    refHost: external ? ref : "",
    source: utm !== "" ? utm : external ? ref : "",
    medium: tag(params.get("utm_medium")),
    campaign: tag(params.get("utm_campaign")),
    out: clicked ? outboundOf(clicked, names) : "",
  };
}
