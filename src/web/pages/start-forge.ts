/**
 * `POST /forges/start` (#11277, #11153): the home page's "Start my forge".
 * A stranger gives a name; the same door as `/forges/new` (`spawnDoor`, the free
 * plan, the visitor limits) makes the forge; the answer is a page that says
 * "Setting up <name>…", asks `GET /forges/<name>/ready` until it says yes, and
 * then goes straight to the new forge's claim page (username and password,
 * signed in on landing). The claim link is in this one no-store body, as the
 * target of a link and a redirect: never shown as text, never to copy.
 * With JavaScript the answer is a 303 to `/forges/<name>/waiting#<code>` instead.
 * A signed-in person is sent to the fuller `/forges/new`, which keeps its form.
 */
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { spawnDoor } from "../../spawn/door.ts";
import { noteForgeMade } from "../funnel_door.ts";
import { field, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { page, redirect } from "../layout.ts";
import { notFoundPage, pageHead } from "../chrome.ts";
import { waitingAddress } from "../claim_code.ts";
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
})(document)`;

/** Waits for the forge, then goes to its claim page; after a minute and a half the link is still there. */
export const startWaitJs = `(function(d){
var a=d.getElementById("start-go"),s=d.getElementById("start-wait");
if(!a||!window.fetch)return;
var n=a.getAttribute("data-name"),u=a.getAttribute("data-href"),tries=0;
function poll(){
fetch("/forges/"+encodeURIComponent(n)+"/ready",{credentials:"omit"}).then(function(r){return r.json()}).then(function(j){
if(j&&j.ready===true){location.replace(u);return}throw 0}).catch(function(){
if(++tries>60){s.textContent=n+" is taking longer than usual. Use the link to open it.";return}
setTimeout(poll,1500)})}
poll()
})(document)`;

/** A forge name the fuller form may be given: 1 to 39 lowercase letters, digits and inner dashes. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

/** The waiting page's body: one sentence, and a plain link that holds the claim address if scripts are off. */
export function startWaitBody(name: string, link: string): Html {
  return html`<div class="narrow stack" data-start-wait>
    ${pageHead("Start my forge")}
    <p id="start-wait" role="status">Setting up ${name}. Next you choose a username and password.</p>
    <p id="start-go" class="small" data-name="${name}" data-href="${link}"><a href="${link}">Open ${name}</a></p>
  </div>`;
}

export async function startForgeSubmit(ctx: Ctx): Promise<Response> {
  const user = ctx.auth.user;
  if (user && user.kind !== "user") return notFoundPage(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const form = await readForm(ctx, user === undefined ? undefined : "admin");
  if (form instanceof Response) return form;
  const typed = field(form, "name").trim();
  const name = typed.toLowerCase();
  if (user !== undefined) return redirect(SLUG.test(name) ? `/forges/new?name=${encodeURIComponent(name)}` : "/forges/new");
  const door = await spawnDoor(ctx, undefined, { name, dryRun: false });
  if (door.status >= 400) {
    // Said on the home page, with the name kept (#11238).
    return redirect(startRefusalHref(startRefusalOf(door), typed));
  }
  const link = door.body["claimUrl"];
  if (typeof link !== "string") return redirect(startRefusalHref("taken", name));
  noteForgeMade(ctx);
  // A browser that ran the page's script goes to the static waiting page, the code in the fragment only (#11202).
  const waiting = field(form, "js") === "1" ? waitingAddress(door.body) : undefined;
  if (waiting !== undefined) {
    const to = redirect(waiting);
    to.headers.set("cache-control", "no-store");
    return to;
  }
  const body = startWaitBody(name, link);
  const response = page({ ctx, title: "Setting up…", body, scriptJs: startWaitJs });
  response.headers.set("cache-control", "no-store");
  return response;
}
