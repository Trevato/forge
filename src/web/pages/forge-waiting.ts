/**
 * `GET /forges/<name>/waiting`: where a stranger with JavaScript waits for the
 * forge they just made (#11202). The page is static and holds no claim code:
 * the code rides the fragment of this address (`#<code>`), which a server never
 * sees. A few lines of script read it, clear it from the address bar, poll
 * `/forges/<name>/ready` (capped), then go to the child's `/welcome#<code>`.
 */
import { isChildName } from "../../core/proposal_token.ts";
import type { Ctx } from "../../http/context.ts";
import { childUrlOf } from "../../spawn/door.ts";
import { notFoundPage, pageHead } from "../chrome.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { CLAIM_CODE } from "../claim_code.ts";

export const WAITING_JS = /* js */ `
(function () {
  var el = document.getElementById("waiting");
  if (!el) return;
  var code = location.hash.slice(1), tries = 0;
  if (!${CLAIM_CODE}.test(code)) { el.textContent = "This link has no claim code. Start again from the new forge page."; return; }
  history.replaceState(null, "", location.pathname);
  var name = el.getAttribute("data-name"), base = el.getAttribute("data-claim");
  function again(ms) {
    if (tries < 120) setTimeout(poll, ms);
    else el.textContent = "This is taking longer than usual. Reload this page in a minute.";
  }
  function poll() {
    tries++;
    fetch("/forges/" + encodeURIComponent(name) + "/ready", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ready) location.replace(base + "#" + code); else again(1000); })
      .catch(function () { again(2000); });
  }
  poll();
})();
`;

export function forgeWaitingPage(ctx: Ctx): Response {
  const name = ctx.params.name ?? "";
  if (!isChildName(name)) return notFoundPage(ctx);
  const claim = `${childUrlOf(ctx.app, name).replace(/\/+$/, "")}/welcome`;
  return page({
    ctx,
    title: "Making your forge",
    scriptJs: WAITING_JS,
    body: html`<div class="narrow stack">
      ${pageHead("Making your forge")}
      <p id="waiting" role="status" data-name="${name}" data-claim="${claim}">It will be ready in a moment.</p>
      <p>You will then choose a username and a password.</p>
      <noscript><p>This page needs JavaScript. Go back and make the forge again to get its link.</p></noscript>
    </div>`,
  });
}
