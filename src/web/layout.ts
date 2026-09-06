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
import { html, raw, when, type Html } from "./html.ts";
import { icon, themeGlyph } from "./icons.ts";
import { btn, iconBtn, kbd, menu, type MenuItem } from "./ui.ts";

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
   * Page-specific CSS (e.g. dynamic label colors). Emitted in a nonce'd
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

function userMenu(user: User): Html {
  const items: MenuItem[] = [
    { label: "Your profile", href: `/${user.username}`, icon: "user" },
    { label: "Your repositories", href: "/", icon: "repo" },
    { label: "Apps", href: "/apps", icon: "rocket" },
    { separator: true, label: "" },
    { label: "Settings", href: "/settings", icon: "settings" },
    { label: "Access tokens", href: "/settings/tokens", icon: "key" },
    { label: "SSH keys", href: "/settings/keys", icon: "lock" },
    { label: "Origins", href: "/settings/origins", icon: "globe" },
    ...(user.isAdmin
      ? [{ label: "Crew", href: "/settings/crew", icon: "bot" as const }]
      : []),
    { separator: true, label: "" },
    { label: "Sign out", post: "/logout", icon: "signOut" },
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

const STATIC_PALETTE: PaletteItem[] = [
  { t: "Home", h: "/", c: "Go" },
  { t: "Apps", h: "/apps", c: "Go" },
  { t: "New app", h: "/apps/new", c: "Create" },
  { t: "New repository", h: "/new", c: "Create" },
  { t: "New organization", h: "/organizations/new", c: "Create" },
  { t: "Search", h: "/search", c: "Go" },
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
 */
function paletteIndex(ctx: Ctx, extra: PaletteItem[]): Html {
  const repos = listReposVisibleTo(ctx.app.db, ctx.auth.user, { limit: 30 });
  const items: PaletteItem[] = [
    ...extra,
    ...repos.map((r) => ({
      t: `${r.ownerName}/${r.name}`,
      h: `/${r.ownerName}/${r.name}`,
      c: "Repository",
    })),
    ...STATIC_PALETTE,
  ];
  const json = JSON.stringify({ items }).replaceAll("<", "\\u003c");
  return raw(
    `<script type="application/json" id="palette-index">${json}</script>`,
  );
}

function overlays(): Html {
  return html`<dialog
      class="dialog palette"
      id="palette"
      aria-label="Command palette"
    >
      <input
        class="input palette-input"
        type="search"
        placeholder="Jump to a repository, page or action…"
        aria-label="Command palette search"
        autocomplete="off"
      />
      <div class="palette-list" role="listbox" aria-label="Results"></div>
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

// ---- the page ----

export function page(options: PageOptions, status = 200): Response {
  // A per-response nonce lets exactly this page's <style> and <script> run
  // while everything else stays forbidden.
  const nonce = secret();
  const { ctx } = options;
  const theme = ctx.theme;
  const user = ctx.auth.user;
  const flash = readFlash(ctx.request);
  const scriptJs = options.scriptJs
    ? `${shellJs}\n${options.scriptJs}`
    : shellJs;

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
        <a class="skip" href="#main">Skip to content</a>
        <header class="topbar" role="banner">
          <a href="/" class="wordmark" data-shortcut="g h"
            ><span class="mark"></span>forge</a
          >
          ${when(
            options.crumbs,
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
            ${searchBar()}${helpButton()}${themeMenu(theme)}
            ${user
              ? html`${newMenu()}${userMenu(user)}`
              : btn("Sign in", { href: "/signin" })}
          </span>
        </header>
        <main class="shell" id="main">
          ${flash ? flashToast(flash) : null}${options.body}
        </main>
        <footer class="foot">
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
        </footer>
        ${overlays()} ${paletteIndex(ctx, options.palette ?? [])}
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
 */
export function fragment(body: Html, status = 200): Response {
  return new Response(body.text, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'none'; sandbox",
      "cache-control": "no-store",
    },
  });
}

/** Redirect back to a page carrying a message — the shape most handlers want. */
export function flashTo(ctx: Ctx, to: string, flash: Flash): Response {
  return redirect(to, { flash, url: ctx.url });
}
