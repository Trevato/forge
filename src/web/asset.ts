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
import { createLog } from "../kernel/log.ts";
import { css } from "./style.ts";

const log = createLog("web");

export interface BuiltAsset {
  /** The URL path it is served from, content-hashed. */
  path: string;
  /** The `:name` the route matches, i.e. the path's basename without `.js`. */
  name: string;
  code: string;
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
    const name = `highlight-${sha256(code).slice(0, 16)}`;
    return { path: `/assets/${name}.js`, name, code };
  } catch (error) {
    log.warn("web.highlight_asset_failed", { error: String(error) });
    return null;
  }
}

/** The response for a hit on the built asset: immutable, because it is. */
export function assetResponse(asset: BuiltAsset): Response {
  return new Response(asset.code, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

/** The stylesheet, content-addressed the same way. Hashed once per process. */
export interface CssAsset {
  /** The URL path it is served from, content-hashed. */
  path: string;
  /** The `:name` the route matches, i.e. the path's basename without `.css`. */
  name: string;
}

let cssAsset: CssAsset | null = null;

export function stylesheetAsset(): CssAsset {
  if (cssAsset === null) {
    const name = `forge-${sha256(css).slice(0, 16)}`;
    cssAsset = { path: `/assets/${name}.css`, name };
  }
  return cssAsset;
}

/** The response for a hit on the stylesheet: immutable, because it is. */
export function stylesheetResponse(): Response {
  return new Response(css, {
    headers: {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
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
