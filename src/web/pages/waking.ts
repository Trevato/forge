/**
 * What a visitor sees at a sleeping forge's address: it is waking, or the host
 * will not wake it right now. Drawn with the page shell and its components, so
 * it follows the theme; a browser asks again by itself (`refresh`), a git
 * client or an API call gets a sentence (`spawn/sleep.ts` `wakingText`).
 */

import type { App } from "../../app.ts";
import type { Ctx } from "../../http/context.ts";
import { wakingText } from "../../spawn/sleep.ts";
import { btn, empty } from "../ui.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";

/** Waking (`why` undefined, 503) or refused (`why` a sentence, 429), as a page when the visitor asks for HTML. */
export function wakingResponse(app: App, request: Request, name: string, why?: string): Response {
  if (!(request.headers.get("accept") ?? "").includes("text/html")) return wakingText(name, why);
  const url = new URL(request.url);
  const ctx: Ctx = { app, request, url, params: {}, auth: { user: undefined, scope: undefined, via: "none" }, theme: undefined };
  const response = page(
    {
      ctx,
      bare: true,
      title: why === undefined ? "Waking up" : "Not now",
      body: html`<div class="narrow-wide">
        ${empty({
          icon: "history",
          title: why === undefined ? "Waking up" : "Not now",
          note: why ?? `${name} was asleep. It is waking up and this page tries again by itself in a few seconds.`,
          action: btn("Try again", { href: url.pathname, variant: "primary" }),
        })}
      </div>`,
    },
    why === undefined ? 503 : 429,
  );
  response.headers.set("retry-after", "5");
  response.headers.set("cache-control", "no-store");
  if (why === undefined) response.headers.set("refresh", "3");
  return response;
}
