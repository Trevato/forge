/**
 * `POST /forges/start` (#11277, #11153): the home page's "Start my forge".
 * A stranger gives a name; the same door as `/forges/new` (`spawnDoor`, the free
 * plan, the visitor limits) makes the forge; the answer is the one page that
 * says what is happening while it starts and hands over its link the moment it
 * answers (`web/forge_made.ts`), in a no-store body. The answer does not wait
 * on the first reach proof: the page shows the start itself.
 * A signed-in person is sent to the fuller `/forges/new`, which keeps its form.
 */
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { spawnDoor } from "../../spawn/door.ts";
import { noteForgeMade } from "../funnel_door.ts";
import { field, readForm } from "../form.ts";
import { madeBody, madeJs } from "../forge_made.ts";
import { page, redirect } from "../layout.ts";
import { notFoundPage } from "../chrome.ts";
import { startRefusalHref, startRefusalOf } from "../start_refusal.ts";

/** The home's live name check: asks `GET /forges/name/<name>` and says free, taken, or the route's own reason; a 429 or a failure says nothing. */
export const startNameJs = `(function(d){
var i=d.getElementById("start-name"),s=d.getElementById("start-name-says"),t,k=0;
if(!i||!s||!window.fetch)return;
function say(m){s.textContent=m}
i.addEventListener("input",function(){
clearTimeout(t);var n=i.value.trim().toLowerCase(),q=++k;
if(!n){say("");return}
if(!/^[a-z0-9][a-z0-9-]*$/.test(n)){say("Use lowercase letters, digits and dashes.");return}
t=setTimeout(function(){fetch("/forges/name/"+encodeURIComponent(n),{credentials:"omit"}).then(function(r){
return r.status===200?r.json():null}).then(function(j){
if(q!==k||!j)return;say(j.verdict==="free"?n+" is free.":j.verdict==="taken"?n+" is taken. Try another.":typeof j.why==="string"?j.why:"")}).catch(function(){})},300)})
})(document);`;

/** A forge name the fuller form may be given: 1 to 39 lowercase letters, digits and inner dashes. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

export async function startForgeSubmit(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user && user.kind !== "user") return notFoundPage(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const form = await readForm(ctx, user === undefined ? undefined : "admin");
  if (form instanceof Response) return form;
  const typed = field(form, "name").trim();
  const name = typed.toLowerCase();
  if (user !== undefined) return redirect(SLUG.test(name) ? `/forges/new?name=${encodeURIComponent(name)}` : "/forges/new");
  const door = await spawnDoor(ctx, undefined, { name, dryRun: false }, { page: true });
  if (door.status >= 400) {
    // Said on the home page, with the name kept (#11238).
    return redirect(startRefusalHref(startRefusalOf(door), typed));
  }
  const link = door.body["claimUrl"];
  if (typeof link !== "string") return redirect(startRefusalHref("taken", name));
  noteForgeMade(ctx);
  // Made for themselves: its own account screen, never the one for a link someone sent.
  const body = madeBody({ name, link: link.replace(/\/claim#/, "/welcome#"), own: true });
  const response = page({ ctx, title: "Your new forge", body, scriptJs: madeJs });
  response.headers.set("cache-control", "no-store");
  return response;
}
