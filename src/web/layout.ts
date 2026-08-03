/**
 * The page shell. Every page shares one topbar, one stylesheet, and one
 * Content-Security-Policy strict enough that the pages must earn any script
 * they ever ship. Pages work with zero JavaScript — enhancement is a later
 * privilege, not a load-bearing wall.
 */

import type { User } from "../core/users.ts";
import { html, when, type Html } from "./html.ts";

export interface PageOptions {
  title: string;
  user: User | undefined;
  /** Breadcrumb segments rendered in the topbar, e.g. owner / repo. */
  crumbs?: { label: string; href: string }[];
  body: Html;
}

export function page(options: PageOptions, status = 200): Response {
  const doc = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${options.title} · forge</title>
        <link rel="stylesheet" href="/assets/forge.css" />
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
      // No inline styles or scripts anywhere — the stylesheet is the only
      // resource a page loads, so the policy can forbid everything else.
      "content-security-policy":
        "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
