/**
 * What a visitor sees at the address of a forge whose billing is `none`
 * (#11393): one server-rendered page that says what happened in a sentence,
 * offers the button to pay again (the sale's checkout, `billing/pay_again.ts`)
 * and says how to take the data. The apps stay asleep until paid. A browser
 * gets the page, anything else the sentence. The button posts to this same
 * address; `payAgainRoute` answers it, same-origin only.
 */

import type { App } from "../../app.ts";
import type { Lapse } from "../../billing/lapse.ts";
import { exportSentence, lapsedSentence } from "../../billing/lapse_words.ts";
import { canPayAgain, startPayAgain } from "../../billing/pay_again.ts";
import { publicOrigin } from "../../core/public_origin.ts";
import type { Ctx } from "../../http/context.ts";
import { takeDoor, tooManyStrangers } from "../../http/strangers.ts";
import { btn, empty } from "../ui.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";

export const PAY_AGAIN_PATH = "/pay-again";

export { exportSentence, lapsedSentence };

/** The answer for a lapsed forge's address: the page for a browser, the sentence for the rest. 402, never cached. */
export function lapsedResponse(app: App, request: Request, name: string, lapse: Extract<Lapse, { state: "none" }>): Response {
  const url = new URL(request.url);
  const front = publicOrigin(app.config.url, url.origin);
  const exportLine = exportSentence(lapse, front);
  if (!(request.headers.get("accept") ?? "").includes("text/html")) {
    const text = new Response(`${lapsedSentence(name)}\n${exportLine}\n`, { status: 402, headers: { "content-type": "text/plain; charset=utf-8" } });
    text.headers.set("cache-control", "no-store");
    return text;
  }
  const ctx: Ctx = { app, request, url, params: {}, auth: { user: undefined, scope: undefined, via: "none" }, theme: undefined };
  const pay = canPayAgain(app, name);
  const response = page(
    {
      ctx,
      bare: true,
      title: "Asleep",
      body: html`<div class="narrow-wide">
        ${empty({
          icon: "history",
          title: "This forge is asleep",
          note: lapsedSentence(name),
          action: pay
            ? html`<form method="post" action="${PAY_AGAIN_PATH}">${btn("Pay again", { variant: "primary" })}</form>`
            : html`<p class="muted">Paying is not set up on this forge yet; ask its operator.</p>`,
        })}
        <p class="muted small" id="export">${exportLine}</p>
      </div>`,
    },
    402,
  );
  response.headers.set("cache-control", "no-store");
  return response;
}

/**
 * POST /pay-again on a lapsed forge's address: make the checkout and send the
 * payer to it. Refused unless the request comes from this very address.
 */
export async function payAgainRoute(app: App, request: Request, name: string): Promise<Response> {
  const host = request.headers.get("host") ?? "";
  const from = request.headers.get("origin");
  let same = false;
  try {
    same = from !== null && new URL(from).host === host;
  } catch {
    same = false;
  }
  if (!same) return new Response("not allowed", { status: 403, headers: { "cache-control": "no-store" } });
  // Anyone may press it, and each press calls the payment provider: count it per address.
  const turn = takeDoor(app, "pay", request);
  if (!turn.allowed) return tooManyStrangers({ retryAfter: turn.retryAfter, why: "too many attempts to pay again; retry shortly" });
  const made = await startPayAgain(app, name, new URL(request.url).origin);
  if (!made.ok) return new Response(`${made.error}\n`, { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  return new Response(null, { status: 303, headers: { location: made.value, "cache-control": "no-store" } });
}
