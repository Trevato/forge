/**
 * The page shell. Every page shares one topbar, one stylesheet, and one
 * Content-Security-Policy strict enough that the pages must earn any script
 * they ever ship. Pages work with zero JavaScript — enhancement is a later
 * privilege, not a load-bearing wall. That includes the theme switcher: a
 * plain form POST persists the choice; script only makes it instant.
 */

import type { User } from "../core/users.ts";
import { secret } from "../kernel/id.ts";
import { html, raw, when, type Html } from "./html.ts";
import {
  metaThemeColor,
  THEME_NAMES,
  THEMES,
  type ThemeName,
} from "./themes.ts";

export interface PageOptions {
  title: string;
  user: User | undefined;
  /**
   * The visitor's persisted theme (from the forge_theme cookie), stamped on
   * <html> so the page renders themed with no flash. Absent means "system".
   */
  theme?: ThemeName | undefined;
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
}

/** A crisp half-filled circle: the theme toggle glyph, legible in any theme. */
const themeIcon = raw(
  `<svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">` +
    `<circle cx="7.5" cy="7.5" r="5.75" stroke="currentColor" stroke-width="1.5"/>` +
    `<path d="M7.5 1.75a5.75 5.75 0 0 1 0 11.5Z" fill="currentColor"/>` +
    `</svg>`,
);

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
      <span class="tick" aria-hidden="true">✓</span>
    </label>`;
  return html`<details class="menu theme-menu">
    <summary
      class="btn btn-icon"
      data-size="sm"
      aria-label="Choose theme"
      title="Theme"
    >
      ${themeIcon}
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

function userMenu(user: User): Html {
  return html`<details class="menu">
    <summary class="btn" data-size="sm">${user.username}</summary>
    <div class="menu-panel">
      <a class="menu-item" href="/${user.username}">Profile</a>
      <a class="menu-item" href="/new">New repository</a>
      <a class="menu-item" href="/organizations/new">New organization</a>
      <a class="menu-item" href="/settings/tokens">Tokens</a>
      <hr class="menu-sep" />
      <form method="post" action="/logout">
        <button class="menu-item" type="submit">Sign out</button>
      </form>
    </div>
  </details>`;
}

/**
 * Shared shell enhancement: dropdowns dismiss on outside click / Escape, and
 * a theme choice applies instantly (the form still persists it). Static code
 * only — runtime data never reaches this string.
 */
const shellJs = /* js */ `
(function () {
  function closeMenus(except) {
    document.querySelectorAll('details.menu[open]').forEach(function (menu) {
      if (menu !== except) menu.removeAttribute('open');
    });
  }
  document.addEventListener('click', function (e) {
    closeMenus(e.target.closest ? e.target.closest('details.menu') : null);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeMenus(null);
  });

  var form = document.querySelector('.theme-menu form');
  if (!form) return;
  var apply = form.querySelector('.theme-apply');
  if (apply) apply.hidden = true;
  form.addEventListener('change', function () {
    var choice = new FormData(form).get('theme');
    var root = document.documentElement;
    root.classList.add('theme-anim');
    if (!choice || choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', String(choice));
    window.setTimeout(function () { root.classList.remove('theme-anim'); }, 300);
    fetch(form.action, { method: 'POST', body: new FormData(form) })
      .catch(function () {});
  });
})();
`;

export function page(options: PageOptions, status = 200): Response {
  // A per-response nonce lets exactly this page's <style> and <script> run
  // while everything else stays forbidden.
  const nonce = secret();
  const theme = options.theme;
  const scriptJs = options.scriptJs
    ? `${shellJs}\n${options.scriptJs}`
    : shellJs;
  const doc = html`<!doctype html>
    <html lang="en" ${theme ? html`data-theme="${theme}"` : null}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${options.title} · forge</title>
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
        ${options.styleCss
          ? raw(`<style nonce="${nonce}">${options.styleCss}</style>`)
          : null}
      </head>
      <body>
        <a class="skip" href="#main">Skip to content</a>
        <header class="topbar">
          <a href="/" class="wordmark"><span class="mark"></span>forge</a>
          ${when(
            options.crumbs,
            (crumbs) =>
              html`<nav class="crumbs">
                ${crumbs.map(
                  (crumb, i) =>
                    html`${i > 0 ? html`<span class="sep">/</span>` : null}<a
                        href="${crumb.href}"
                        >${crumb.label}</a
                      >`,
                )}
              </nav>`,
          )}
          <span class="spacer"></span>
          ${themeMenu(theme)}
          ${options.user
            ? html`<a
                  class="btn hide-sm"
                  data-variant="primary"
                  data-size="sm"
                  href="/new"
                  >New</a
                >
                ${userMenu(options.user)}`
            : html`<a class="btn" data-size="sm" href="/signin">Sign in</a>`}
        </header>
        <main class="shell" id="main">${options.body}</main>
        <footer class="foot">
          <span class="mark"></span>
          <span>forge — your code, your machine</span>
        </footer>
        ${raw(`<script nonce="${nonce}">${scriptJs}</script>`)}
      </body>
    </html>`;

  return new Response(doc.text, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The external stylesheet plus this page's own nonce'd <style>/<script>
      // are the only resources allowed; connect-src 'self' lets the live
      // event stream (EventSource) and fragment fetches reach same-origin.
      "content-security-policy": `default-src 'none'; style-src 'self' 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
    },
  });
}

export function redirect(to: string, setCookie?: string): Response {
  const headers: Record<string, string> = { location: to };
  if (setCookie !== undefined) headers["set-cookie"] = setCookie;
  return new Response(null, { status: 303, headers });
}
