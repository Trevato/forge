/**
 * The home's side of the selling funnel (#11259): the first step noted when a
 * stranger is served the home, the name the free start goes by, the forge made
 * from the form, and the small script that reports the plans coming into view
 * and a plan's button pressed (`http/funnel.ts` receives it). Nothing is sent
 * under Do-Not-Track or the opt-out cookie; the server checks both again.
 */

import type { Ctx } from "../http/context.ts";
import { clientAddress } from "../http/peer.ts";
import { START } from "../http/funnel.ts";
import { noteStep } from "../perf/funnel.ts";
import { originOf } from "../perf/sources.ts";
import type { Plan } from "../settings/plans.ts";
import { optedOut } from "./measure.ts";

/** The free plan's name, or `start` when no plan is free. */
export const freePlanName = (plans: readonly Plan[]): string => plans.find((p) => p.priceUsd === 0)?.name ?? START;

const agentOf = (ctx: Ctx): string => ctx.request.headers.get("user-agent") ?? "";

export function noteHomeVisit(ctx: Ctx): void {
  if (optedOut(ctx.request)) return;
  noteStep(ctx.app.db, {
    kind: "home",
    client: clientAddress(ctx.request),
    agent: agentOf(ctx),
    // The referrer header, as the beacon's document.referrer, and the query for utm_ tags.
    origin: originOf(ctx.request.headers.get("referer") ?? undefined, ctx.url.search, ctx.url.host, undefined),
  });
}

/** A forge was made from the form; the visitor's hash is the home's, so the steps line up. */
export function noteForgeMade(ctx: Ctx): void {
  if (optedOut(ctx.request)) return;
  noteStep(ctx.app.db, { kind: "forge", client: clientAddress(ctx.request), agent: agentOf(ctx) });
}

/** Runs once the page is ready: plans in view once; a click on a [data-plan] sends its plan. */
export const funnelJs = `(function(n,d){
if(n.doNotTrack=="1"||/(^|; )forge_measure=off/.test(d.cookie)||!n.sendBeacon)return;
function p(o){n.sendBeacon("/_funnel",JSON.stringify(o))}
var l=d.querySelector(".door-plans");
if(l&&window.IntersectionObserver){var io=new IntersectionObserver(function(e){e.some(function(x){return x.isIntersecting})&&(io.disconnect(),p({step:"plans"}))});io.observe(l)}
d.addEventListener("click",function(e){var t=e.target,k=t&&t.closest&&t.closest("[data-plan]");k&&p({step:"click",plan:k.getAttribute("data-plan")})},true)
})(navigator,document);`;
