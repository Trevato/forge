/**
 * The page shell. Every page shares one topbar, one stylesheet, and one
 * Content-Security-Policy strict enough that the pages must earn any script
 * they ever ship. Pages work with zero JavaScript — enhancement is a later
 * privilege, not a load-bearing wall.
 */

import type { User } from "../core/users.ts";
import { secret } from "../kernel/id.ts";
import { html, raw, when, type Html } from "./html.ts";

export interface PageOptions {
  title: string;
  user: User | undefined;
  /** Breadcrumb segments rendered in the topbar, e.g. owner / repo. */
  crumbs?: { label: string; href: string }[];
  body: Html;
  /**
   * Page-specific CSS (e.g. dynamic label colors). Emitted in a nonce'd
   * <style> the strict CSP allows. Must be trusted CSS the page generated —
   * never unescaped user text.
   */
  styleCss?: string;
}

export function page(options: PageOptions, status = 200): Response {
  // A per-response nonce lets exactly this page's <style> (and, later, a
  // <script>) run while everything else stays forbidden.
  const nonce = secret();
  const doc = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${options.title} · forge</title>
        <link rel="stylesheet" href="/assets/forge.css" />
        ${options.styleCss
          ? raw(`<style nonce="${nonce}">${options.styleCss}</style>`)
          : null}
      </head>
      <body>
        <header class="topbar">
          <a href="/" class="wordmark">forge</a>
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
          ${options.user
            ? html`<a class="btn" data-size="sm" href="/new">New</a>
                <form method="post" action="/logout">
                  <button class="btn" data-size="sm" type="submit">
                    Sign out ${options.user.username}
                  </button>
                </form>`
            : html`<a class="btn" data-size="sm" href="/signin">Sign in</a>`}
        </header>
        <main class="shell">${options.body}</main>
      </body>
    </html>`;

  return new Response(doc.text, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The external stylesheet plus this page's own nonce'd <style>/<script>
      // are the only resources allowed; everything else is forbidden.
      "content-security-policy": `default-src 'none'; style-src 'self' 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
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
