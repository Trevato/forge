/**
 * GET /privacy: what the forge keeps about a visitor, in three plain lines
 * (#11265). Public, static, server-rendered.
 */

import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";

export function privacyPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  return timePhase(ctx.request, "render", () =>
    page({
      ctx,
      title: "Privacy",
      body: html`<div class="page-head"><h1>Privacy</h1></div>
        <ul class="list">
          <li>
            Kept: a random visitor id in a first-party cookie (or, without it, a salted hash of your browser family, OS,
            language and network prefix), when you came, the page paths you opened (no query string) and the site you
            came from. Never your address or your full browser string.
          </li>
          <li>
            For how long: 13 months after you were last seen, then deleted. The hash's salt changes every 30 days.
          </li>
          <li>
            It never leaves this forge: it is shared with no one. A request with Global Privacy Control or Do Not Track
            gets no cookie and no visitor record, and the owner can turn this off.
          </li>
        </ul>`,
      }),
  );
}
