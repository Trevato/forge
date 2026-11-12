/**
 * The Arcade: one repository's display (`display/config.ts`), served at
 * `arcade.<app domain>`: the display titled `arcade-builds` in a repository
 * a site admin owns, the newest of several (`display/known.ts`); with none,
 * the host answers 404. A display in the shelf layout is browser-arcade's page as
 * it was — the chunky carousel, the console and the jbox boot tag — fed by
 * the display's items (`shelf.ts`); any other layout is drawn by the
 * forge, so the host's root sends a person there.
 *
 * The host answers on an app's kind of hostname, its own origin, for two
 * reasons: a cart is a stranger's page, and must never run as the forge;
 * and a cart keeps its saves in that origin's storage, which a sandboxed
 * frame would refuse it. `arcade` is a reserved app name, so no app can
 * stand in its place. Nobody is signed in on this origin: the display is
 * read as a stranger reads it: a showcased demo from a private source is
 * on it, published, by its opaque id and never its repository. It is also
 * where every display's `file` demos play (`display/launch.ts`), with an
 * Arcade display or not: a page in a public repository at its plain
 * address, a private one with a grant, and a published one by its display
 * and id (`displays/…`), plain when the display is public.
 */

import { readFileSync } from "node:fs";
import type { App } from "../app.ts";
import { appHostSuffix } from "../apps/host.ts";
import { parseAppHost } from "../apps/proxy.ts";
import { appsRuntime, type AppsRuntime } from "../apps/runtime.ts";
import { canRead, getRepo, ownerInStanding, type Repo } from "../core/repos.ts";
import { arcadeRepoKnown, arcadeRepoOf } from "../display/known.ts";
import { readDisplay, type DisplayConfig } from "../display/config.ts";
import { displayItem, displayItems } from "../display/items.ts";
import { verifyCart } from "../display/launch.ts";
import { coverType, listBuildPins, readCover } from "../git/builds.ts";
import { repoDir } from "../git/repos.ts";
import type { Result } from "../kernel/result.ts";
import { pageFile, readArt, readCapture } from "./carts.ts";
import { COVER_JS } from "./cover.ts";
import { shelfOf, type Shelf } from "./shelf.ts";
import { snapshotFile } from "./snapshot.ts";

/** The app name the Arcade answers at. */
export const ARCADE_SLUG = "arcade";

/** Whether a request's `Host` is the Arcade's. */
export function isArcadeHost(host: string | null, domain: string): boolean {
  if (host === null) return false;
  const parsed = parseAppHost(host, domain);
  return parsed !== undefined && parsed.slug === ARCADE_SLUG && parsed.env === "production" && !parsed.nested;
}

/** Where the Arcade is reached, as the runtime addresses an app. */
export function arcadeUrl(runtime: AppsRuntime): string {
  const { scheme, publicPort, domain } = runtime.options;
  const port =
    publicPort === undefined || (scheme === "http" && publicPort === 80) || (scheme === "https" && publicPort === 443)
      ? ""
      : `:${publicPort}`;
  return `${scheme}://${ARCADE_SLUG}${appHostSuffix(domain)}${port}`;
}

/** Whether the forge has an Arcade: apps run and a site admin's display is titled `arcade-builds`. */
export function arcadeOn(app: App): boolean {
  return appsRuntime(app) !== undefined && arcadeRepoKnown(app) !== undefined;
}

/** The Arcade's address when the forge has one. */
export function arcadeHome(app: App): string | undefined {
  const runtime = appsRuntime(app);
  return runtime !== undefined && arcadeRepoKnown(app) !== undefined ? arcadeUrl(runtime) : undefined;
}

/** Where Launch goes for this display: its host, when it is the Arcade's shelf and apps run. */
export async function launchUrl(app: App, repo: Repo, config: Result<DisplayConfig, string> | undefined): Promise<string | undefined> {
  if (config === undefined) return undefined;
  if (!config.ok || config.value.layout !== "shelf") return undefined;
  return (await arcadeRepoOf(app))?.id === repo.id ? arcadeHome(app) : undefined;
}

const file = (name: string): string => readFileSync(new URL(name, import.meta.url), "utf8");
let page: string | undefined;
let boot: string | undefined;
let template: Uint8Array | undefined;

/** The Arcade's page, with the house cover drawing spliced in. */
export function arcadePage(): string {
  page ??= file("./arcade.html").replace("/*COVER_JS*/", () => COVER_JS);
  return page;
}
export const bootScript = (): string => (boot ??= file("./jbox-spin.js"));
export const coverTemplateBytes = (): Uint8Array =>
  (template ??= new Uint8Array(readFileSync(new URL("./cover-template.png", import.meta.url))));

const IMPORT_LINE = "import { jboxScale, playJboxSpin } from './boot/jbox-spin.js';";
const escapeText = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * The shelf page for a display: its title, its producer, and — for a page
 * that carries its shelf inside it — the data, with the boot tag inline.
 */
export function shelfPage(o: { title: string; producer: string | undefined; data?: unknown; tabTitle?: string; bar?: string }): string {
  let out = arcadePage();
  // The forge's own bar above the shelf (a writer's Edit display), outside the arcade's frame.
  if (o.bar !== undefined) out = out.replace('<body>\n  <header id="topline">', () => `<body>\n  ${o.bar}\n  <header id="topline">`);
  const topline = o.producer === undefined ? o.title : `${o.producer} • ${o.title}`;
  out = out
    .replace("<title>Browser Arcade</title>", () => `<title>${escapeText(o.tabTitle ?? o.title)}</title>`)
    .replace('<header id="topline">JBOX • BROWSER ARCADE</header>', () => `<header id="topline">${escapeText(topline.toUpperCase())}</header>`)
    .replace('<button id="back" type="button">◀ ARCADE</button>', () => `<button id="back" type="button">◀ ${escapeText(o.title.toUpperCase())}</button>`);
  if (o.data === undefined) return out;
  if (!out.includes(IMPORT_LINE)) throw new Error("the Arcade page no longer imports the boot tag as expected");
  // The boot tag goes inline, as plain script in the page's module.
  out = out.replace(IMPORT_LINE, () => bootScript().replace(/^export /gm, ""));
  // "<" escaped, so a cart's own </script> cannot end this script early.
  const data = JSON.stringify(o.data).replace(/</g, "\\u003c");
  return out.replace('<script type="module">', () => `<script>window.__ARCADE__ = ${data};</script>\n  <script type="module">`);
}

/** The page's own policy: no third-party fonts, its inline module, carts in frames from itself. */
const PAGE_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "font-src 'none'; img-src 'self' data: blob:; frame-src 'self' blob:; media-src 'self' blob: data:; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

const answer = (body: string | Uint8Array, type: string, extra: Record<string, string> = {}): Response =>
  new Response(body, {
    headers: {
      "content-type": type,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...extra,
    },
  });

const missing = (): Response =>
  new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "content-security-policy": "default-src 'none'", "x-content-type-options": "nosniff" },
  });

export interface ArcadeDisplay {
  readonly repo: Repo;
  readonly config: Result<DisplayConfig, string>;
}

/**
 * The Arcade's display, read as a stranger reads it; undefined when there is
 * none to show. A site admin titling a display `arcade-builds` publishes it,
 * as Showcase publishes a demo: a private display repository is served all
 * the same, and its private sources stay unnamed.
 */
export async function arcadeDisplay(app: App): Promise<ArcadeDisplay | undefined> {
  const repo = await arcadeRepoOf(app);
  if (repo === undefined) return undefined;
  const config = await readDisplay(app, repo);
  return config === undefined ? undefined : { repo, config };
}

/**
 * A captured page any display may play: the pin at `oid` in that
 * repository has its demo in the showcase and the page is captured, and
 * the repository is public or the request carries a grant for this page.
 */
async function servePlayable(app: App, path: string, grant: string | null): Promise<Response> {
  const m = /^carts\/([^/]+)\/([^/]+)\/([0-9a-f]{40,64})\/([A-Za-z0-9._-]+)\.html$/.exec(path);
  if (m === null) return missing();
  const [, owner, name, oid, page] = m as unknown as [string, string, string, string, string];
  const repo = getRepo(app.db, owner, name);
  if (repo === undefined || !ownerInStanding(app.db, repo)) return missing();
  if (!canRead(app.db, repo, undefined) && (grant === null || !verifyCart(app.config.dataDir, path, grant))) return missing();
  const pins = await listBuildPins(repoDir(app.reposRoot, repo.ownerName, repo.name));
  const pin = pins.find((p) => p.oid === oid && p.demo?.showcase === true && pageFile(p.demo.page) === page);
  if (pin?.demo === undefined) return missing();
  const html = readCapture(app.config.dataDir, repo, oid, pin.demo.page);
  return html === undefined ? missing() : answer(html, "text/html; charset=utf-8", { "content-security-policy": cartAncestors(app) });
}

/**
 * A published demo, by the display that shows it and its id there: its
 * captured page, its cover or its page's picture. The display must be
 * public or the Arcade's named display, or the request carry a grant for
 * this path; the demo must be in the display's showcase now.
 */
async function serveShown(app: App, path: string, grant: string | null): Promise<Response> {
  const m = /^displays\/([^/]+)\/([^/]+)\/([A-Za-z0-9_-]{22})(\.html|\/cover\.png|\/art\.png)$/.exec(path);
  if (m === null) return missing();
  const [, owner, name, id, kind] = m as unknown as [string, string, string, string, string];
  const display = getRepo(app.db, owner, name);
  if (display === undefined || !ownerInStanding(app.db, display)) return missing();
  const published = canRead(app.db, display, undefined) || (await arcadeRepoOf(app))?.id === display.id;
  if (!published && (grant === null || !verifyCart(app.config.dataDir, path, grant))) return missing();
  const config = await readDisplay(app, display);
  if (config === undefined || !config.ok) return missing();
  const item = await displayItem(app, display, config.value, id);
  if (item === undefined) return missing();
  const { repo, pin, demo } = item;
  if (kind === "/cover.png") {
    const bytes = demo.cover === undefined ? undefined : await readCover(repoDir(app.reposRoot, repo.ownerName, repo.name), demo.cover);
    return bytes === undefined ? missing() : answer(bytes, coverType(bytes) ?? "application/octet-stream");
  }
  if (kind === "/art.png") {
    const bytes = readArt(app.config.dataDir, repo, pin.oid, demo.page);
    return bytes === undefined ? missing() : answer(bytes, "image/png");
  }
  const html = readCapture(app.config.dataDir, repo, pin.oid, demo.page);
  return html === undefined ? missing() : answer(html, "text/html; charset=utf-8", { "content-security-policy": cartAncestors(app) });
}

/** A cart may frame only inside a display: this origin's or the forge's own. */
function cartAncestors(app: App): string {
  const forge = appsRuntime(app)?.options.forgeUrl;
  return `frame-ancestors 'self'${forge === undefined ? "" : ` ${new URL(forge).origin}`}`;
}

const errorPage = (message: string): Response =>
  new Response(`<!doctype html><meta charset="utf-8"><title>Display</title><p>${escapeText(message)}</p>`, {
    status: 422,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'", "x-content-type-options": "nosniff" },
  });

/** Answer one request to the Arcade's host. */
export async function serveArcade(app: App, request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  const url = new URL(request.url);
  let path: string;
  try {
    path = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return missing();
  }
  // Every display's carts play here, Arcade or not.
  if (path.startsWith("carts/")) return servePlayable(app, path, url.searchParams.get("g"));
  if (path.startsWith("displays/")) return serveShown(app, path, url.searchParams.get("g"));
  const display = await arcadeDisplay(app);
  if (display === undefined) return missing();
  if (!display.config.ok) return errorPage(display.config.error);
  const config = display.config.value;
  // Grid and graph are drawn by the forge.
  if (config.layout !== "shelf") {
    const forge = appsRuntime(app)?.options.forgeUrl;
    if (forge === undefined || (path !== "" && path !== "index.html")) return missing();
    return new Response(null, { status: 303, headers: { location: `${forge.replace(/\/$/, "")}/${display.repo.ownerName}/${display.repo.name}/display` } });
  }
  if (path === "" || path === "index.html")
    return answer(shelfPage({ title: config.title, producer: config.shelf.producer }), "text/html; charset=utf-8", { "content-security-policy": PAGE_POLICY });
  if (path === "boot/jbox-spin.js") return answer(bootScript(), "text/javascript; charset=utf-8");
  if (path === "cover-template.png") return answer(coverTemplateBytes(), "image/png");
  const shelf: Shelf = shelfOf(await displayItems(app, display.repo, config, undefined), config.shelf.producer);
  if (path === "games.json") return answer(JSON.stringify(shelf.games), "application/json");
  // Export snapshot: the display's shelf, in one file that plays offline.
  if (path === "snapshot.html") {
    const made = await snapshotFile(app, config, shelf, new Date());
    return answer(made.html, "text/html; charset=utf-8", { "content-disposition": `attachment; filename="${made.name}"` });
  }
  const entry = shelf.entries.get(path);
  if (entry === undefined) return missing();
  const { repo, pin, cart } = entry;
  if (path.startsWith("labels/") && cart.cover !== undefined) {
    const bytes = await readCover(repoDir(app.reposRoot, repo.ownerName, repo.name), cart.cover);
    return bytes === undefined ? missing() : answer(bytes, coverType(bytes) ?? "application/octet-stream");
  }
  if (path.startsWith("art/")) {
    const bytes = readArt(app.config.dataDir, repo, pin.oid, cart.page);
    return bytes === undefined ? missing() : answer(bytes, "image/png");
  }
  return missing();
}
