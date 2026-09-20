/**
 * The page shell. Every page shares one topbar, one stylesheet, and one
 * Content-Security-Policy strict enough that a page must earn any script it
 * ever ships. Pages work with zero JavaScript — enhancement is a later
 * privilege, not a load-bearing wall. That includes the theme switcher (a
 * plain form POST persists the choice), the command palette (a link to
 * `/search`), and every dialog (a link to a real page).
 */

import { listReposVisibleTo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import type { Ctx } from "../http/context.ts";
import { edgeLoginUrl, edgeLogoutUrl } from "../http/edge.ts";
import { json } from "../http/respond.ts";
import { secret } from "../kernel/id.ts";
import {
  metaThemeColor,
  THEME_NAMES,
  THEMES,
  type ThemeName,
} from "../design/themes.ts";
import { shellJs } from "./client.ts";
import {
  clearFlashCookie,
  flashCookie,
  readFlash,
  type Flash,
} from "./flash.ts";
import { prefersJson } from "./form.ts";
import { html, raw, when, type Html } from "./html.ts";
import { icon, iconSprite, inlineIcons, themeGlyph } from "./icons.ts";
import { appsOf, askCountFor } from "./studio/asks.ts";
import { btn, iconBtn, kbd, menu, pill, type MenuItem } from "./ui.ts";

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
 * Studio or dev, for this browser. Two buttons, one form each, so the
 * choice is a POST like the theme's and never a query parameter that
 * leaks into links.
 */
function modeToggle(ctx: Ctx): Html {
  if (!ctx.auth.user) return html``;
  const back = ctx.url.pathname + ctx.url.search;
  const one = (mode: "studio" | "dev", label: string) =>
    html`<form method="post" action="/mode">
      <input type="hidden" name="mode" value="${mode}" />
      <input type="hidden" name="back" value="${back}" />
      <button
        type="submit"
        aria-pressed="${ctx.mode === mode ? "true" : "false"}"
        title="${mode === "studio"
          ? "Apps, the crew, what asks you"
          : "Code, commits, branches, runs"}"
      >
        ${label}
      </button>
    </form>`;
  return html`<span class="mode-toggle" role="group" aria-label="Studio or dev">
    ${one("studio", "studio")}${one("dev", "dev")}
  </span>`;
}

/**
 * What asks the signed-in person, across every app they can land — the
 * same set the home's own "Asks you" panel counts (`askCountFor`, the
 * cheap query beside `decisionsFor`), never built from the cards
 * themselves. Studio only; dev's top bar never carries it. With nothing
 * asking, the wrapper stays in the document — so a live swap on a page
 * that already streams (the home, an app, the map, the board) can still
 * find it by id and fill it in — but nothing renders inside it: a zero is
 * not a fact worth a badge.
 */
function asksBadge(ctx: Ctx): Html {
  const user = ctx.auth.user;
  if (!user || ctx.mode !== "studio") return html``;
  const count = askCountFor(ctx, appsOf(ctx, user).repos);
  return html`<span id="topbar-asks" data-live="run.*,pull.*,issue.*,check.*"
    >${when(
      count,
      (n) =>
        html`<a
          class="topbar-asks"
          href="/"
          title="${n} thing${n === 1 ? "" : "s"} ask you"
          >${pill(`${n} asks you`, "accent")}</a
        >`,
    )}</span
  >`;
}

function newMenu(): Html {
  const items: MenuItem[] = [
    { label: "New app", href: "/apps/new", icon: "rocket" },
    { label: "New repository", href: "/new", icon: "repo" },
    { label: "New organization", href: "/organizations/new", icon: "users" },
  ];
  return menu({
    trigger: icon("plus"),
    items,
    label: "Create new",
    title: "Create",
    triggerOptions: { extra: "btn-icon" },
  });
}

function userMenu(user: User, signOut: MenuItem): Html {
  const items: MenuItem[] = [
    { label: "Your profile", href: `/${user.username}`, icon: "user" },
    { label: "Your repositories", href: "/", icon: "repo" },
    { label: "Apps", href: "/apps", icon: "rocket" },
    { label: "Map", href: "/map", icon: "map" },
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
  return html`<button
    class="btn btn-icon js-only"
    type="button"
    data-help
    aria-label="Keyboard shortcuts"
    title="Keyboard shortcuts"
  >
    ${icon("help")}
  </button>`;
}

// ---- palette index ----

const STATIC_PALETTE_DEV: PaletteItem[] = [
  { t: "Home", h: "/", c: "Go to" },
  { t: "Apps", h: "/apps", c: "Go to" },
  { t: "Map", h: "/map", c: "Go to" },
  { t: "New app", h: "/apps/new", c: "Create" },
  { t: "New repository", h: "/new", c: "Create" },
  { t: "New organization", h: "/organizations/new", c: "Create" },
  { t: "Search", h: "/search", c: "Go to" },
  { t: "Account settings", h: "/settings", c: "Settings" },
  { t: "Access tokens", h: "/settings/tokens", c: "Settings" },
  { t: "SSH keys", h: "/settings/keys", c: "Settings" },
  { t: "Origins", h: "/settings/origins", c: "Settings" },
];

/**
 * The studio's own verbs: no "New repository" or "New organization" — dev's
 * own way of making one, which would land a studio reader on dev's own form
 * unannounced. "Asks you" goes to the home, where the asks panel lives.
 */
const STATIC_PALETTE_STUDIO: PaletteItem[] = [
  { t: "Home", h: "/", c: "Go to" },
  { t: "Apps", h: "/apps", c: "Go to" },
  { t: "Map", h: "/map", c: "Go to" },
  { t: "Asks you", h: "/", c: "Go to" },
  { t: "New app", h: "/apps/new", c: "Create" },
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
 * In the studio the by-name rows are apps, not every repository — the same
 * visibility (`appsOf` is `listReposVisibleTo` underneath), just apps first.
 */
function paletteIndex(ctx: Ctx, extra: PaletteItem[]): Html {
  const studio = ctx.mode === "studio";
  const repos = studio
    ? appsOf(ctx, ctx.auth.user).repos.slice(0, 30)
    : listReposVisibleTo(ctx.app.db, ctx.auth.user, { limit: 30 });
  const items: PaletteItem[] = [
    ...extra,
    ...repos.map((r) => ({
      t: `${r.ownerName}/${r.name}`,
      h: `/${r.ownerName}/${r.name}`,
      c: studio ? "Apps" : "Repositories",
    })),
    ...(studio ? STATIC_PALETTE_STUDIO : STATIC_PALETTE_DEV),
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
      ${asksBadge(ctx)}
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
        ${searchBar()}${helpButton()}${modeToggle(ctx)}${themeMenu(theme)}
        ${user
          ? html`${newMenu()}${userMenu(
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

function footer(): Html {
  return html`<footer class="foot">
    <span class="mark"></span>
    <span>forge — your code, your machine</span>
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

export function page(options: PageOptions, status = 200): Response {
  // A per-response nonce lets exactly this page's <style> and <script> run
  // while everything else stays forbidden.
  const nonce = secret();
  const { ctx } = options;
  const theme = ctx.theme ?? options.theme;
  const flash = readFlash(ctx.request);
  const scriptJs = options.scriptJs
    ? `${shellJs}\n${options.scriptJs}`
    : shellJs;

  // The body's markup, built before the document so the icons it used can be
  // counted: every `icon()` left a `<use>` behind, and the sprite defining
  // them goes last, after the markup that references it (legal, and resolved
  // once the document is parsed). Only what this page used ships.
  const shell = html`${options.bare ? null : topbar(ctx, theme, options.crumbs)}
    <main class="${options.bare ? "bare" : "shell"}" id="main">
      ${flash ? flashToast(flash) : null}${options.body}
    </main>
    ${options.bare ? null : footer()} ${overlays()}
    ${paletteIndex(ctx, options.palette ?? [])}`;

  const doc = html`<!doctype html>
    <html lang="en" ${theme ? html`data-theme="${theme}"` : null}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${options.title} · forge</title>
        ${when(
          options.refresh,
          (r) =>
            html`<meta
              http-equiv="refresh"
              content="${r.url === undefined
                ? String(r.seconds)
                : `${r.seconds}; url=${r.url}`}"
            />`,
        )}
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
        <link rel="stylesheet" href="/assets/forge.css" />
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
        ${raw(`<script nonce="${nonce}">${scriptJs}</script>`)}
      </body>
    </html>`;

  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    // The external stylesheet plus this page's own nonce'd <style>/<script>
    // are the only resources allowed; connect-src 'self' lets the live
    // event stream (EventSource) and fragment fetches reach same-origin.
    "content-security-policy": `default-src 'none'; style-src 'self' 'nonce-${nonce}'; script-src 'nonce-${nonce}'${options.scriptAsset === undefined ? "" : " 'self'"}; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
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
 */
export function fragment(body: Html, status = 200): Response {
  return new Response(inlineIcons(body.text), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'none'; sandbox",
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
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
