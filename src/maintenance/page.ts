/**
 * The page visitors see while the forge is off: calm, static, escaped, and
 * answerable by anything (the droplet's `scripts/standby.ts`, or a Cloudflare
 * Worker serving the same text). No script, no external asset.
 */

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export interface PageInput {
  /** What the owner said, one line; may be empty. */
  readonly reason?: string;
  /** ISO time the forge went into maintenance, when known. */
  readonly since?: string;
}

export function maintenanceHtml(input: PageInput = {}): string {
  const reason = (input.reason ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
  const since = input.since !== undefined && /^[0-9T:.\-Z+]{10,30}$/.test(input.since) ? input.since : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="60"><title>Back soon</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;min-height:100vh;place-items:center;background:#fafafa;color:#222}main{max-width:32rem;padding:1.5rem}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:.5rem 0}.m{color:#666}@media(prefers-color-scheme:dark){body{background:#151515;color:#eee}.m{color:#aaa}}</style></head><body><main><h1>Back soon</h1><p>The forge is down for planned maintenance and will be back soon.</p>${reason === "" ? "" : `<p>${esc(reason)}</p>`}${since === "" ? "" : `<p class="m">Down since ${esc(since)}.</p>`}<p class="m">This page refreshes itself every minute.</p></main></body></html>`;
}

/** The headers the maintenance page is always served with: 503 so nothing caches it as the real site. */
export const MAINTENANCE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "retry-after": "300",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
