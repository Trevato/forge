/**
 * The page shell. Every page shares one topbar, one stylesheet, and one
 * Content-Security-Policy strict enough that a page must earn any script it
 * ever ships. Pages work with zero JavaScript — enhancement is a later
 * privilege, not a load-bearing wall. That includes the theme switcher (a
 * plain form POST persists the choice), the command palette (a link to
 * `/search`), and every dialog (a link to a real page).
 */

import { askCountFor } from "./studio/asks.ts";
import { appsForRepos } from "../core/apps.ts";
import { listReposVisibleTo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import type { Ctx } from "../http/context.ts";
import { edgeLoginUrl, edgeLogoutUrl } from "../http/edge.ts";
import { json } from "../http/respond.ts";
import { sha256 } from "../kernel/hash.ts";
import { secret } from "../kernel/id.ts";
import { runningLine } from "../kernel/version.ts";
import {
  bootCss,
  metaThemeColor,
  THEME_NAMES,
  THEMES,
  type ThemeName,
} from "../design/themes.ts";
import { shellAsset, stylesheetAsset } from "./asset.ts";
import { linkHeader, pageLinks } from "./standards.ts";
import {
  clearFlashCookie,
  flashCookie,
  readFlash,
  type Flash,
} from "./flash.ts";
import { prefersJson } from "./form.ts";
import { html, raw, when, type Html } from "./html.ts";
import { noRoom } from "../spawn/door.ts";
import { icon, iconSprite, inlineIcons, themeGlyph } from "./icons.ts";
import { btn, kbd, menu, pill, type MenuItem } from "./ui.ts";

/** One row of the command palette: title, href, category. */
export interface PaletteItem {
  t: string;
  h: string;
  c?: string;
}

export interface PageOptions {
  /** The request: user, theme and flash all come from here. */
  ctx: Ctx;
  title: string;
  /**
   * One sentence for the places that show a page before it is opened: a
   * search result, a link unfurled in a chat. A repository's description,
   * an issue's first line. Absent, the forge's own line stands in.
   */
  description?: string;
  /**
   * The shell without its column width: a page whose content earns a wide
   * monitor (the code browser, a tree beside a file). The topbar and footer
   * are unchanged; only the main column lets go of `--page`.
   */
  wide?: boolean;
  /** This page's feed, advertised in the head so a reader can find it. */
  feed?: { href: string; title: string };
  /** Breadcrumb segments rendered in the topbar, e.g. owner / repo. */
  crumbs?: { label: string; href: string }[];
  body: Html;
  /**
   * CSS this request computed: label colors mixed from the labels actually
   * on the page (`labelCss`) are the case this exists for. A rule that is
   * the same for every visitor belongs in the served stylesheet
   * (`web/style.ts`), which the browser already has — the studio's and the
   * board's used to be sent from here and now live there. Emitted in a nonce'd
   * <style> the strict CSP allows. Must be trusted CSS the page generated —
   * never unescaped user text.
   */
  styleCss?: string;
  /**
   * Page-specific JavaScript (progressive enhancement — every page works
   * without it). Emitted in a nonce'd <script>. Must be trusted, static code
   * the page authored, with runtime data passed via `data-*` attributes,
   * never interpolated into the script text.
   */
  scriptJs?: string;
  /**
   * A same-origin script file this page needs (today: the highlighter bundle
   * the editor loads). It is the one thing that relaxes the script CSP — from
   * "this page's nonce only" to "this page's nonce, or a file from this
   * origin" — so pages that do not ask for it keep the stricter policy.
   */
  scriptAsset?: string;
  /** Extra palette rows for this page's context (a repo's own tabs). */
  palette?: PaletteItem[];
  /**
   * The JavaScript-free half of a page that changes on its own: a
   * `<meta http-equiv="refresh">`, optionally to somewhere else. Only a page
   * whose content is genuinely still moving should set it — a refresh a
   * reader did not ask for steals their scroll position and their selection.
   *
   * A plain refresh (no `url`) is written inside `<noscript>`: a browser
   * running the page's script never parses it, so the script's stream is
   * the only thing moving the page. Removing the element afterwards would
   * not do — a refresh is scheduled the moment the parser meets the tag,
   * and the timer outlives the element. A refresh that leads somewhere
   * (`url`) is a redirect and stays in force either way.
   */
  refresh?: { seconds: number; url?: string };
  /**
   * No topbar, no footer, no page width: a page that is the whole window
   * (the board). The overlays stay, so the palette is still one chord away.
   */
  bare?: boolean;
  /** The theme when the viewer has chosen none: for a page that is dark by nature. */
  theme?: ThemeName;
}

// ---- topbar pieces ----

function themeMenu(active: ThemeName | undefined): Html {
  const option = (value: string, label: string, checked: boolean) =>
    html`<label class="theme-option">
      <input
        type="radio"
        name="theme"
        value="${value}"
        ${checked ? raw("checked") : null}
      />
      <span class="swatch" data-t="${value}"></span>
      ${label}
      <span class="tick" aria-hidden="true">${icon("check")}</span>
    </label>`;
  return html`<details class="menu theme-menu">
    <summary class="btn btn-icon" aria-label="Choose theme" title="Theme">
      ${themeGlyph}
    </summary>
    <form class="menu-panel" method="post" action="/theme">
      <span class="menu-title">Theme</span>
      ${option("system", "System", active === undefined)}
      ${THEME_NAMES.map((name) =>
        option(name, THEMES[name].label, active === name),
      )}
      <button class="btn theme-apply" data-size="sm" type="submit">
        Apply
      </button>
    </form>
  </details>`;
}

/**
 * The way to what needs you, with how many things ask the viewer — the very
 * count the home's pinned section leads with (`askCountFor`).
 */
export function asksLink(ctx: Ctx): Html {
  if (!ctx.auth.user) return html``;
  const count = askCountFor(ctx, ctx.auth.user);
  return html`<a
    id="asks-link"
    class="btn"
    data-size="sm"
    href="/#needs-you"
    title="${count === 0 ? "All fine" : `${count} need you`}"
    >Asks${count === 0 ? null : pill(count, "accent")}</a
  >`;
}

/** A whole forge for someone (`/forges/new`): any signed-in person's. */
const NEW_FORGE: MenuItem = {
  label: "New forge",
  href: "/forges/new",
  icon: "fork",
};

/** The door shows to every person; with no room left it is disabled and says why. */
const isPerson = (ctx: Ctx): boolean => ctx.auth.user?.kind === "user";
const sendsForges = (ctx: Ctx): boolean =>
  isPerson(ctx) && noRoom(ctx.app) === undefined;
const forgeDoor = (ctx: Ctx): MenuItem[] => {
  if (!isPerson(ctx)) return [];
  const why = noRoom(ctx.app);
  return [why === undefined ? NEW_FORGE : { ...NEW_FORGE, disabled: why }];
};

function newMenu(ctx: Ctx): Html {
  const items: MenuItem[] = [
    { label: "New app", href: "/apps/new", icon: "rocket" },
    { label: "New repository", href: "/new", icon: "repo" },
    { label: "Migrate", href: "/migrate", icon: "download" },
    { label: "New organization", href: "/organizations/new", icon: "users" },
    ...forgeDoor(ctx),
  ];
  return menu({
    trigger: icon("plus"),
    items,
    label: "Create new",
    title: "Create",
    triggerOptions: { extra: "btn-icon" },
  });
}

function userMenu(ctx: Ctx, user: User, signOut: MenuItem): Html {
  const items: MenuItem[] = [
    { label: "Your profile", href: `/${user.username}`, icon: "user" },
    { label: "Your repositories", href: "/", icon: "repo" },
    { label: "Apps", href: "/apps", icon: "rocket" },
    { label: "Explore", href: "/explore", icon: "search" },
    { label: "Map", href: "/map", icon: "map" },
    { separator: true, label: "" },
    // The "+" menu is hidden on a phone to keep the topbar inside the
    // screen; creating things stays one tap away here.
    { label: "New app", href: "/apps/new", icon: "rocket" },
    { label: "New repository", href: "/new", icon: "repo" },
    { label: "Migrate", href: "/migrate", icon: "download" },
    ...forgeDoor(ctx),
    { separator: true, label: "" },
    { label: "Settings", href: "/settings", icon: "settings" },
    { label: "Access tokens", href: "/settings/tokens", icon: "key" },
    { label: "SSH keys", href: "/settings/keys", icon: "lock" },
    { label: "Origins", href: "/settings/origins", icon: "globe" },
    ...(user.isAdmin
      ? [{ label: "Crew", href: "/settings/crew", icon: "bot" as const }]
      : []),
    { separator: true, label: "" },
    signOut,
  ];
  return menu({
    trigger: html`${icon("user")}<span class="hide-sm">${user.username}</span>`,
    items,
    title: `Signed in as ${user.username}`,
  });
}

function searchBar(): Html {
  return html`<form
      class="topbar-search hide-sm"
      method="get"
      action="/search"
      role="search"
    >
      ${icon("search")}
      <input
        type="search"
        name="q"
        aria-label="Search this forge"
        placeholder="Search"
        autocomplete="off"
        data-search-input
      />
      ${kbd(["/"])}
    </form>
    <a class="btn btn-icon hide-lg" href="/search" aria-label="Search"
      >${icon("search")}</a
    >`;
}

/**
 * Keyboard help. The shortcuts it lists only exist when the script runs, so
 * the button that opens it only exists then too — `js-only` is revealed by
 * the shell script rather than shown and then found to be dead.
 */
function helpButton(): Html {
  // Keyboard shortcuts have no meaning on a phone; the button would only
  // cost the width that pushes the page sideways.
  return html`<button
    class="btn btn-icon js-only hide-sm"
    type="button"
    data-help
    aria-label="Keyboard shortcuts"
    title="Keyboard shortcuts"
  >
    ${icon("help")}
  </button>`;
}

// ---- palette index ----

/** The palette's own verbs: where to go, what to make, what to set. */
const STATIC_PALETTE: PaletteItem[] = [
  { t: "Home", h: "/", c: "Go to" },
  { t: "Apps", h: "/apps", c: "Go to" },
  { t: "Explore", h: "/explore", c: "Go to" },
  { t: "Map", h: "/map", c: "Go to" },
  { t: "Asks you", h: "/#needs-you", c: "Go to" },
  { t: "What you asked for", h: "/asked", c: "Go to" },
  { t: "Front page", h: "/front", c: "Go to" },
  { t: "New app", h: "/apps/new", c: "Create" },
  { t: "New repository", h: "/new", c: "Create" },
  { t: "Migrate a repository", h: "/migrate", c: "Create" },
  { t: "New organization", h: "/organizations/new", c: "Create" },
  { t: "Search", h: "/search", c: "Go to" },
  { t: "Account settings", h: "/settings", c: "Settings" },
  { t: "Access tokens", h: "/settings/tokens", c: "Settings" },
  { t: "SSH keys", h: "/settings/keys", c: "Settings" },
  { t: "Origins", h: "/settings/origins", c: "Settings" },
];

/**
 * The palette index rides as a `<script type="application/json">` data block.
 * The HTML spec stops parsing such a block as script, so the CSP never
 * applies and no nonce is needed — but `</script` must not appear inside it,
 * which escaping `<` guarantees.
 *
 * The by-name rows are every repository the viewer can see, apps among them.
 */
function paletteIndex(ctx: Ctx, extra: PaletteItem[]): Html {
  // One forge (#603): a conversation's remote row is built with the
  // studio's nouns, which answer for every repository.
  const studio = true;
  // Apps first, then the other repositories, thirty in all.
  const repos = listReposVisibleTo(ctx.app.db, ctx.auth.user, {
    limit: 30,
    appsFirst: true,
  });
  const apps = appsForRepos(
    ctx.app.db,
    repos.map((r) => r.id),
  );
  const items: PaletteItem[] = [
    ...extra,
    ...repos.map((r) => ({
      t: `${r.ownerName}/${r.name}`,
      h: `/${r.ownerName}/${r.name}`,
      c: apps.has(r.id) ? "Apps" : "Repositories",
    })),
    ...STATIC_PALETTE,
    ...(sendsForges(ctx)
      ? [{ t: "New forge", h: "/forges/new", c: "Create" }]
      : []),
    ...(ctx.auth.user?.isAdmin
      ? [{ t: "Forges you sent", h: "/forges", c: "Go to" }]
      : []),
  ];
  // `studio` rides along so the palette's *remote* rows — what the search
  // API found, folded in the browser — build the same addresses the server
  // just rendered (`tellHref`/`changeHref`, `src/web/studio/nouns.ts`). The
  // palette can never hand out a noun the page behind it would not.
  const json = JSON.stringify({ items, studio }).replaceAll("<", "\\u003c");
  return raw(
    `<script type="application/json" id="palette-index">${json}</script>`,
  );
}

/**
 * The palette is a combobox over a listbox inside a modal dialog: the input
 * owns the focus and points at the highlighted row (`aria-activedescendant`,
 * set by the script), the rows are options under group headings. Plain
 * `type="text"`: a search field's own Escape (clear the box) would eat the
 * one that should close the dialog.
 */
function overlays(): Html {
  return html`<dialog
      class="dialog palette"
      id="palette"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <input
        class="input palette-input"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-haspopup="listbox"
        aria-controls="palette-list"
        aria-autocomplete="list"
        placeholder="Jump to a repository, page or action…"
        aria-label="Command palette"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
      />
      <div
        class="palette-list"
        id="palette-list"
        role="listbox"
        aria-label="Results"
      ></div>
      <div class="palette-foot">
        ${kbd(["↑", "↓"])} navigate ${kbd(["↵"])} open ${kbd(["esc"])} close
      </div>
    </dialog>
    <dialog class="dialog" id="help-dialog" aria-labelledby="help-title">
      <div class="dialog-head"><h2 id="help-title">Keyboard shortcuts</h2></div>
      <div class="dialog-body" data-help-body></div>
      <div class="dialog-foot">
        <form method="dialog">
          <button class="btn" type="submit">Close</button>
        </form>
      </div>
    </dialog>`;
}

function flashToast(flash: Flash): Html {
  const tone = flash.tone ?? "success";
  const glyph =
    tone === "danger" ? "alert" : tone === "attn" ? "alert" : "check";
  return html`<div class="toast" data-tone="${tone}" role="status">
    ${icon(glyph)}
    <div class="toast-body">
      ${flash.message}
      ${when(
        flash.code,
        (code) =>
          html`<span class="clone"
            ><span class="clone-text" id="flash-code">${code}</span>
            <button
              class="btn btn-icon"
              data-size="sm"
              type="button"
              data-copy="flash-code"
              aria-label="Copy"
              title="Copy"
            >
              ${icon("copy")}
            </button></span
          >`,
      )}
    </div>
  </div>`;
}

// ---- the chrome ----

/** The skip link and the topbar: the wordmark, the crumbs, the tools. */
function topbar(
  ctx: Ctx,
  theme: ThemeName | undefined,
  crumbs: PageOptions["crumbs"],
): Html {
  const user = ctx.auth.user;
  return html`<a class="skip" href="#main">Skip to content</a>
    <header class="topbar" role="banner">
      <a href="/" class="wordmark" data-shortcut="g h"
        ><span class="mark"></span>forge</a
      >
      ${when(
        crumbs,
        (items) =>
          html`<nav class="crumbs" aria-label="Location">
            ${items.map(
              (crumb, i) =>
                html`${i > 0 ? html`<span class="sep">/</span>` : null}<a
                    href="${crumb.href}"
                    >${crumb.label}</a
                  >`,
            )}
          </nav>`,
      )}
      <span class="spacer"></span>
      <span class="topbar-tools">
        ${searchBar()}<span class="hide-sm">${helpButton()}</span>${asksLink(
          ctx,
        )}${themeMenu(theme)}
        ${user
          ? html`<span class="hide-sm">${newMenu(ctx)}</span>${userMenu(
                ctx,
                user,
                ctx.auth.via === "edge"
                  ? {
                      label: "Sign out",
                      href: edgeLogoutUrl("/"),
                      icon: "signOut",
                    }
                  : { label: "Sign out", post: "/logout", icon: "signOut" },
              )}`
          : btn("Sign in", {
              href:
                ctx.app.config.edgeToken === undefined
                  ? "/signin"
                  : edgeLoginUrl(ctx.url.pathname + ctx.url.search),
            })}
      </span>
    </header>`;
}

/**
 * The foot of every page. A site admin reads what is running there, as the
 * build stamped it (`kernel/version.ts`), in place of the line everyone
 * else gets: the one person who is asked "which version is this?".
 */
function footer(ctx: Ctx): Html {
  return html`<footer class="foot">
    <span class="mark"></span>
    <span
      >forge
      ${ctx.auth.user?.isAdmin === true
        ? runningLine()
        : "— your code, your machine"}</span
    >
    <span class="spacer"></span>
    <button
      class="btn js-only"
      data-variant="link"
      data-size="sm"
      type="button"
      data-palette
    >
      Command palette
    </button>
  </footer>`;
}

// ---- the page ----

const SITE_LINE = "Your code, your machine.";

function pageDescription(options: PageOptions): string {
  const own = options.description?.trim().split(/\r?\n/)[0]?.trim() ?? "";
  const line = own === "" ? SITE_LINE : own;
  return line.length <= 200 ? line : `${line.slice(0, 197).trimEnd()}…`;
}

/**
 * The `<meta http-equiv="refresh">` for `PageOptions.refresh`. A redirect
 * (`url`) is a bare tag; a reload is wrapped in `<noscript>`, so only a
 * browser with no script ever schedules it.
 */
export function refreshMeta(r: { seconds: number; url?: string }): Html {
  if (r.url !== undefined)
    return html`<meta
      http-equiv="refresh"
      content="${r.seconds}; url=${r.url}"
    />`;
  return html`<noscript
    ><meta http-equiv="refresh" content="${String(r.seconds)}"
  /></noscript>`;
}

export function page(options: PageOptions, status = 200): Response {
  // A per-response nonce lets exactly this page's <style> and <script> run
  // while everything else stays forbidden.
  const nonce = secret();
  const { ctx } = options;
  const theme = ctx.theme ?? options.theme;
  const flash = readFlash(ctx.request);
  const links = pageLinks(ctx);

  // The body's markup, built before the document so the icons it used can be
  // counted: every `icon()` left a `<use>` behind, and the sprite defining
  // them goes last, after the markup that references it (legal, and resolved
  // once the document is parsed). Only what this page used ships.
  const shell = html`${options.bare ? null : topbar(ctx, theme, options.crumbs)}
    <main
      class="${options.bare
        ? "bare"
        : options.wide
          ? "shell shell-wide"
          : "shell"}"
      id="main"
    >
      ${flash ? flashToast(flash) : null}${options.body}
    </main>
    ${options.bare ? null : footer(ctx)} ${overlays()}
    ${paletteIndex(ctx, options.palette ?? [])}`;

  const doc = html`<!doctype html>
    <html lang="en" ${theme ? html`data-theme="${theme}"` : null}>
      <head>
        <meta charset="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <title>${options.title} · forge</title>
        <meta name="description" content="${pageDescription(options)}" />
        <meta property="og:site_name" content="forge" />
        <meta property="og:type" content="website" />
        <meta property="og:title" content="${options.title}" />
        <meta property="og:description" content="${pageDescription(options)}" />
        ${
          // Only a page that exists has a canonical address. An error page
          // never echoes the path that was asked for: two dead links must be
          // the same bytes, or the difference tells a guesser something.
          status === 200
            ? html`<meta
                property="og:url"
                content="${ctx.url.origin}${ctx.url.pathname}"
              />`
            : null
        }
        <meta
          property="og:image"
          content="${ctx.url.origin}/icons/forge-512.png"
        />
        <meta name="twitter:card" content="summary" />
        <link rel="manifest" href="/manifest.webmanifest" />
        ${links.map(
          (l) =>
            html`<link
              rel="${l.rel}"
              href="${l.href}"
              ${l.title === undefined ? null : html`title="${l.title}"`}
              ${l.type === undefined ? null : html`type="${l.type}"`}
            />`,
        )}
        <link rel="apple-touch-icon" href="/icons/forge-180.png" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="forge" />
        ${when(
          options.feed,
          (f) =>
            html`<link
              rel="alternate"
              type="application/atom+xml"
              title="${f.title}"
              href="${f.href}"
            />`,
        )}
        ${when(options.refresh, refreshMeta)}
        ${theme
          ? html`<meta name="theme-color" content="${metaThemeColor(theme)}" />`
          : html`<meta
                name="theme-color"
                media="(prefers-color-scheme: light)"
                content="${metaThemeColor("light")}"
              />
              <meta
                name="theme-color"
                media="(prefers-color-scheme: dark)"
                content="${metaThemeColor("dark")}"
              />`}
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%232563eb'/%3E%3Cstop offset='1' stop-color='%237c3aed'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect x='3' y='3' width='26' height='26' rx='8' fill='url(%23g)'/%3E%3C/svg%3E"
        />
        ${raw(`<style nonce="${nonce}">${bootCss}</style>`)}
        <link rel="stylesheet" href="${stylesheetAsset().path}" />
        ${when(
          options.scriptAsset,
          (src) => html`<script type="module" src="${src}"></script>`,
        )}
        ${options.styleCss
          ? raw(`<style nonce="${nonce}">${options.styleCss}</style>`)
          : null}
      </head>
      <body>
        ${shell}${iconSprite(shell.text)}
        <script nonce="${nonce}" src="${shellAsset().path}"></script>
        ${options.scriptJs
          ? raw(`<script nonce="${nonce}">${options.scriptJs}</script>`)
          : null}
      </body>
    </html>`;

  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    // The external stylesheet plus this page's own nonce'd <style>/<script>
    // are the only resources allowed; connect-src 'self' lets the live
    // event stream (EventSource) and fragment fetches reach same-origin.
    "content-security-policy": `default-src 'none'; style-src 'self' 'nonce-${nonce}'; script-src 'nonce-${nonce}'${options.scriptAsset === undefined ? "" : " 'self'"}; connect-src 'self'; worker-src 'self'; manifest-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    // Markup is revalidated every time; only the hashed assets it names are
    // cached, so no cache can pair new HTML with an old stylesheet.
    "cache-control": "no-cache",
    link: linkHeader(links),
  });
  // A flash is shown exactly once: rendering it is also what clears it.
  if (flash) headers.append("set-cookie", clearFlashCookie(ctx.url));
  return new Response(doc.text, { status, headers });
}

export interface RedirectOptions {
  /** A Set-Cookie value to send alongside (session, theme). */
  cookie?: string;
  /** A message to show on the page we are redirecting to. */
  flash?: Flash;
  /** Needed only so the flash cookie learns whether to be Secure. */
  url?: URL;
}

export function redirect(
  to: string,
  options: RedirectOptions | string = {},
): Response {
  const o: RedirectOptions =
    typeof options === "string" ? { cookie: options } : options;
  const headers = new Headers({ location: to });
  if (o.cookie !== undefined) headers.append("set-cookie", o.cookie);
  if (o.flash !== undefined)
    headers.append("set-cookie", flashCookie(o.flash, o.url));
  return new Response(null, { status: 303, headers });
}

/**
 * A slice of a page, for a script that is replacing one region of it. The
 * sandbox CSP is the point: this markup is inserted into a live document, so
 * it is served with a policy that would make it inert if anything ever
 * navigated to it directly.
 *
 * Its icons are inlined rather than referenced: a fragment cannot count on
 * the sprite of the document it is being dropped into, and must not add ids
 * to it (`inlineIcons`, `icons.ts`).
 *
 * A fragment names its own bytes: the `etag` is a hash of the body, and a
 * request carrying it back as `if-none-match` gets a 304 and nothing to
 * paint. `cache-control: no-store` keeps the browser's own cache out of it —
 * the live client holds the tag itself and asks conditionally on purpose,
 * so an unchanged region costs one round trip and no repaint.
 *
 * The same tag is stamped on the fragment's first element as `data-etag`,
 * because a proxy in between may drop the header: Cloudflare strips `etag`
 * from HTML it reserves the right to rewrite, and did on the live forge.
 * The hash is of the unstamped body, so the server recomputes it the same
 * way next time; the request header is what it compares.
 */
export function fragment(
  body: Html,
  o: { status?: number; request?: Request } = {},
): Response {
  const text = inlineIcons(body.text);
  const status = o.status ?? 200;
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'; style-src 'none'; sandbox",
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  };
  if (status !== 200) return new Response(text, { status, headers });
  const hash = sha256(text).slice(0, 16);
  headers.etag = `"${hash}"`;
  if (o.request?.headers.get("if-none-match") === headers.etag)
    return new Response(null, { status: 304, headers });
  return new Response(
    text.replace(/^(\s*<[a-zA-Z][^\s>]*)/, `$1 data-etag="${hash}"`),
    { status, headers },
  );
}

/** Redirect back to a page carrying a message — the shape most handlers want. */
export function flashTo(ctx: Ctx, to: string, flash: Flash): Response {
  return redirect(to, { flash, url: ctx.url });
}

/**
 * A form's answer with two faces: the redirect and flash a plain form gets,
 * or — when the client asked for JSON, to act in place — `{ ok: true,
 * flash }` or `{ ok: false, error }` (422), with anything `extra` beside it.
 * One route, one outcome; only the way it is told differs.
 */
export function flashOrJson(
  ctx: Ctx,
  to: string,
  flash: Flash,
  extra: Record<string, unknown> = {},
): Response {
  if (!prefersJson(ctx)) return flashTo(ctx, to, flash);
  return flash.tone === "danger"
    ? json({ ok: false, error: flash.message, ...extra }, 422)
    : json({ ok: true, flash: flash.message, ...extra });
}
