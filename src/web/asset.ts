/**
 * The one script this forge ships as a file.
 *
 * Everything else on the web is server-rendered HTML plus a nonce'd inline
 * script, and that is the right shape for a page: nothing to fetch, nothing to
 * cache-bust, nothing to get out of sync with the server. The editor is the
 * exception — it needs the *tokenizer itself* in the browser, and inlining two
 * thousand lines of it into every editor page would be absurd.
 *
 * So at first use we bundle `web/highlight-client.ts` with `Bun.build` (no
 * build step, no toolchain, no dependency: the runtime already has a bundler),
 * hash the output, and serve it at a content-addressed URL that can be cached
 * forever. Change the tokenizer and the URL changes with it; nothing else
 * moves. The build is memoized per process, and a failure is not fatal — the
 * editor simply degrades to a plain textarea, which is what it is anyway with
 * JavaScript switched off.
 */

import { sha256 } from "../kernel/hash.ts";
import { encodeOnce, MIN_BYTES, negotiate } from "../http/compress.ts";
import { createLog } from "../kernel/log.ts";
import { beaconJs } from "./beacon.ts";
import { shellJs } from "./client.ts";
import { css } from "./style.ts";

const log = createLog("web");

export interface BuiltAsset {
  /** The URL path it is served from, content-hashed. */
  path: string;
  /** The `:name` the route matches, i.e. the path's basename without `.js`. */
  name: string;
  code: string;
  /** The strong ETag, hashed once with the name. */
  etag: string;
}

let pending: Promise<BuiltAsset | null> | null = null;

/** The highlighter bundle, built once per process. */
export function highlightAsset(): Promise<BuiltAsset | null> {
  pending ??= build();
  return pending;
}

async function build(): Promise<BuiltAsset | null> {
  try {
    const built = await Bun.build({
      entrypoints: [`${import.meta.dir}/highlight-client.ts`],
      target: "browser",
      format: "esm",
      minify: true,
    });
    const first = built.outputs[0];
    if (!built.success || first === undefined) {
      log.warn("web.highlight_asset_failed", { logs: built.logs.length });
      return null;
    }
    const code = await first.text();
    const hash = sha256(code);
    const name = `highlight-${hash.slice(0, 16)}`;
    return { path: `/assets/${name}.js`, name, code, etag: `"${hash}"` };
  } catch (error) {
    log.warn("web.highlight_asset_failed", { error: String(error) });
    return null;
  }
}

/**
 * A content-hashed body, answered conditionally. The ETag is the body's own
 * hash, strong, computed once by the caller; a matching `If-None-Match` (or `*`) gets a 304 with no body
 * and the same validators, and the security floor is added to it like any
 * other response. Only hashed assets come through here, so only they are
 * immutable.
 */
export function staticResponse(request: Request, body: string, type: string, etag: string): Response {
  const headers: Record<string, string> = {
    "content-type": type,
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    vary: "Accept-Encoding",
    etag,
  };
  if (matches(request.headers.get("if-none-match"), etag))
    return new Response(null, { status: 304, headers });
  const encoding = negotiate(request.headers.get("accept-encoding"));
  const bytes = new TextEncoder().encode(body);
  if (encoding === null || bytes.length < MIN_BYTES || request.method === "HEAD") return new Response(body, { headers });
  // Hashed, so the encoded bytes are as immutable as the plain ones: made once.
  return new Response(encodeOnce(etag, bytes, encoding), { headers: { ...headers, "content-encoding": encoding } });
}

function matches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((tag) => tag.trim() === etag);
}

/** The response for a hit on the built asset: immutable, because it is. */
export function assetResponse(request: Request, asset: BuiltAsset): Response {
  return staticResponse(request, asset.code, "text/javascript; charset=utf-8", asset.etag);
}

/** The stylesheet, content-addressed the same way. Hashed once per process. */
export interface CssAsset {
  /** The URL path it is served from, content-hashed. */
  path: string;
  /** The `:name` the route matches, i.e. the path's basename without `.css`. */
  name: string;
  /** The strong ETag, hashed once with the name. */
  etag: string;
}

let cssAsset: CssAsset | null = null;

export function stylesheetAsset(): CssAsset {
  if (cssAsset === null) {
    const hash = sha256(css);
    const name = `forge-${hash.slice(0, 16)}`;
    cssAsset = { path: `/assets/${name}.css`, name, etag: `"${hash}"` };
  }
  return cssAsset;
}

/** The response for a hit on the stylesheet: immutable, because it is. */
export function stylesheetResponse(request: Request): Response {
  return staticResponse(request, css, "text/css; charset=utf-8", stylesheetAsset().etag);
}

/** `/assets/forge.css` for pages rendered before the hash: send them to the current sheet, never cached long. */
export function stylesheetRedirect(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: stylesheetAsset().path,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}

let shell: BuiltAsset | null = null;

/**
 * The shell script, content-addressed like the stylesheet. Hashed once per
 * process. Linked as a classic (blocking) script ahead of the page's own
 * inline one, so everything it defines is in scope when that runs, exactly as
 * when the two were one inline block.
 */
export function shellAsset(): BuiltAsset {
  if (shell === null) {
    const hash = sha256(shellJs);
    const name = `shell-${hash.slice(0, 16)}`;
    shell = { path: `/assets/${name}.js`, name, code: shellJs, etag: `"${hash}"` };
  }
  return shell;
}

let beacon: BuiltAsset | null = null;

/** The page-view beacon (`web/beacon.ts`), content-addressed and immutable. */
export function beaconAsset(): BuiltAsset {
  if (beacon === null) {
    const hash = sha256(beaconJs);
    const name = `beacon-${hash.slice(0, 16)}`;
    beacon = { path: `/assets/${name}.js`, name, code: beaconJs, etag: `"${hash}"` };
  }
  return beacon;
}
