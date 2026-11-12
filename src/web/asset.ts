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

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../kernel/hash.ts";
import { encodeOnce, MIN_BYTES, negotiate } from "../http/compress.ts";
import { createLog } from "../kernel/log.ts";
import { beaconJs } from "./beacon.ts";
import { shellJs } from "./client.ts";
import { spriteSvg } from "./icons.ts";
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
export function staticResponse(request: Request, body: string | Uint8Array<ArrayBuffer>, type: string, etag: string): Response {
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
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  if (encoding === null || bytes.length < MIN_BYTES || request.method === "HEAD") return new Response(bytes, { headers });
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
 * process. Linked `defer`; the page's own inline script waits for
 * DOMContentLoaded, which fires after deferred scripts, so everything the
 * shell defines is in scope when that runs.
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

/**
 * Small files a page names, content-addressed the same way: the icon sprite,
 * the speculation rules, and each page's own script. `name` is the basename
 * without the extension, so one route per extension finds it.
 */
export interface FileAsset extends BuiltAsset {
  type: string;
}

function fileAsset(prefix: string, ext: string, body: string, type: string): FileAsset {
  const hash = sha256(body);
  const name = `${prefix}-${hash.slice(0, 16)}`;
  return { path: `/assets/${name}.${ext}`, name, code: body, etag: `"${hash}"`, type };
}

let sprite: FileAsset | null = null;

/** Every icon, once: `<use href="/assets/i-<hash>.svg#i-name">` points here. */
export function spriteAsset(): FileAsset {
  sprite ??= fileAsset("i", "svg", spriteSvg(), "image/svg+xml; charset=utf-8");
  return sprite;
}

/**
 * Where the browser may prefetch ahead of a click. Moderate eagerness: on
 * hover or pointer-down, never on sight. Only plain GET pages — nothing under
 * the API, the assets, the sign-in edge, the MCP or a raw file, and nothing a
 * link marks `download` or `rel=nofollow`.
 */
/**
 * Paths a hover must never fetch: not a page of reading but a GET that
 * signs in or out, confirms, claims, redeems, redirects or opens something
 * (`/-/confirm`, `/claim`, `/first-admin`, `/verify`, `/go/<code>`, ...),
 * plus everything that is a file, an API or an edge hand-off.
 */
export const NO_PREFETCH_PATHS = [
  "/assets/*", "/api/*", "/_plat/*", "/_measure*", "/_script-error", "/mcp*", "/oauth/*", "/sw.js",
  "/*/*/raw/*", "/*/*/media/*", "/*/*/archive/*", "/*/*/app/*/open",
  "/logout*", "/signout*", "/sign-out*", "/signin*", "/sign-in*", "/login*",
  "/claim*", "/welcome*", "/first-admin*", "/verify*", "/go/*", "/-/*", "/apps/open*",
  "/settings/*", "/home/*", "/*/-/*",
];

/** Query strings that carry a secret or a one-time action, whatever the path. */
export const NO_PREFETCH_QUERY = [
  "*token=*", "*code=*", "*key=*", "*secret=*", "*sig=*", "*nonce=*", "*confirm=*", "*csrf=*", "*session=*",
  "*invite=*", "*otp=*", "*password=*", "*state=*",
];

const SPECULATION = JSON.stringify({
  prefetch: [
    {
      where: {
        and: [
          { href_matches: "/*" },
          { not: { href_matches: NO_PREFETCH_PATHS } },
          { not: { href_matches: NO_PREFETCH_QUERY.map((search) => ({ search })) } },
          { not: { selector_matches: "[rel~=nofollow], [download], [data-no-prefetch]" } },
        ],
      },
      eagerness: "moderate",
    },
  ],
});

let speculation: FileAsset | null = null;

export function speculationAsset(): FileAsset {
  speculation ??= fileAsset("speculation", "json", SPECULATION, "application/speculationrules+json");
  return speculation;
}

// The set of page scripts is static (the code is trusted, data rides in
// `data-*`), so these maps are never evicted: a cached page or an edge copy
// may name a script for as long as it lives, and it must still be served.
const pageScripts = new Map<string, FileAsset>();
const pageScriptsByName = new Map<string, FileAsset>();

/**
 * A page's own script, as a file. The code is trusted and static (runtime
 * data rides in `data-*` attributes), so the same page names the same file
 * on every request and the browser keeps it for a year. Wrapped to wait for
 * DOMContentLoaded, which fires after the deferred shell has run.
 *
 * Given the data dir, the first render in a process also keeps the file under
 * `<dataDir>/page-scripts/`, so a process that has not rendered that page yet
 * (a restart, a new deploy) still answers an edge copy or a cached page that
 * names it. Scripts are composed per page from many constants, so there is no
 * list to register at boot; the disk is the list.
 */
export function pageScriptAsset(js: string, dataDir?: string): FileAsset {
  const body = `document.addEventListener("DOMContentLoaded",()=>{${js}\n})`;
  const key = sha256(body);
  let asset = pageScripts.get(key);
  if (asset === undefined) {
    asset = fileAsset("page", "js", body, "text/javascript; charset=utf-8");
    remember(key, asset);
  }
  if (dataDir !== undefined) keep(dataDir, asset);
  return asset;
}

function remember(key: string, asset: FileAsset): void {
  pageScripts.set(key, asset);
  pageScriptsByName.set(asset.name, asset);
}

const PAGE_SCRIPT_NAME = /^page-[0-9a-f]{16}$/;
/** A kept script nothing has rendered for this long is dropped (edge copies live minutes). */
export const PAGE_SCRIPT_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const kept = new Set<string>();
const pruned = new Set<string>();

export const pageScriptDir = (dataDir: string): string => join(dataDir, "page-scripts");

/** Write once per data dir per process; touch it if it is there, so pruning spares what is in use. */
function keep(dataDir: string, asset: FileAsset): void {
  const id = `${dataDir}\0${asset.name}`;
  if (kept.has(id)) return;
  kept.add(id);
  const dir = pageScriptDir(dataDir);
  const file = join(dir, `${asset.name}.js`);
  try {
    mkdirSync(dir, { recursive: true });
    if (!pruned.has(dir)) {
      pruned.add(dir);
      prune(dir);
    }
    if (existsSync(file)) {
      const now = new Date();
      utimesSync(file, now, now);
      return;
    }
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, asset.code);
    renameSync(tmp, file);
  } catch (error) {
    // Not fatal: this process still serves it from memory.
    log.warn("web.page_script_keep_failed", { error: String(error) });
  }
}

function prune(dir: string): void {
  const cutoff = Date.now() - PAGE_SCRIPT_KEEP_MS;
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry);
    try {
      if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
    } catch {
      // Raced with another writer; the next boot looks again.
    }
  }
}

/**
 * A page script by its hashed name: rendered by this process, or kept on disk
 * by an earlier one. The name is checked before it touches the path, and the
 * body read back must hash to it, or it is not served.
 */
export function pageScriptNamed(name: string, dataDir?: string): FileAsset | undefined {
  const known = pageScriptsByName.get(name);
  if (known !== undefined || dataDir === undefined || !PAGE_SCRIPT_NAME.test(name)) return known;
  let body: string;
  try {
    body = readFileSync(join(pageScriptDir(dataDir), `${name}.js`), "utf8");
  } catch {
    return undefined;
  }
  const asset = fileAsset("page", "js", body, "text/javascript; charset=utf-8");
  if (asset.name !== name) return undefined;
  remember(sha256(body), asset);
  return asset;
}

export function fileResponse(request: Request, asset: FileAsset): Response {
  return staticResponse(request, asset.code, asset.type, asset.etag);
}
