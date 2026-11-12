/**
 * `/pinned` (#10106): the pinned forges, one block of plain rows each, read
 * from the same `pinnedForges` the API, MCP and terminal use. The last check
 * is when the newest `pinned.check` event for the forge was written.
 */

import type { PinnedView } from "../../actions/pinned.ts";
import { html, type Html } from "../html.ts";
import { badge, btn, time, type Tone } from "../ui.ts";

const TONE: Record<string, Tone> = { running: "success", failed: "danger" };

/** What the page needs beyond the forges: user id to name, forge name to the time of its last check. */
export interface PinnedFacts {
  readonly names: Map<string, string>;
  readonly checks: Map<string, string>;
}

const fact = (label: string, value: Html): Html => html`<div class="status-row"><dt>${label}</dt><dd>${value}</dd></div>`;
const none = (text: string): Html => html`<span class="muted">${text}</span>`;

/** Update asks for the version, Roll back and Check for nothing; each goes through the confirm page, which posts to `/pinned/<name>/<act>`. */
function actions(p: PinnedView): Html {
  const to = (act: string): string => `/pinned/${p.name}/${act}`;
  return html`<div class="form-actions">
    <form method="get" action="/-/confirm">
      <input type="hidden" name="to" value="${to("update")}" />
      <input class="mono" name="version" value="${p.version}" maxlength="40" required spellcheck="false" autocomplete="off" aria-label="Version for ${p.name}" />
      ${btn("Update", { variant: "secondary" })}
    </form>
    <form method="get" action="/-/confirm">
      <input type="hidden" name="to" value="${to("rollback")}" />
      ${btn("Roll back", { variant: "secondary", label: `Roll back ${p.name}` })}
    </form>
    <form method="get" action="/-/confirm">
      <input type="hidden" name="to" value="${to("check")}" />
      ${btn("Check", { variant: "ghost", label: `Check ${p.name}` })}
    </form>
  </div>`;
}

function forge(p: PinnedView, f: PinnedFacts): Html {
  const last = p.changes[0];
  const checked = f.checks.get(p.name);
  return html`<section>
    <h2 class="mono">${p.name}</h2>
    <dl class="status-rows">
      ${fact("App", html`<span class="mono">${p.app}</span>`)}
      ${fact("Version", html`<span class="mono" title="${p.version}">${p.version.slice(0, 12)}</span>`)}
      ${fact("Address", p.url === "" ? none("not read yet") : html`<a class="mono" href="${p.url}" rel="noopener noreferrer">${p.url}</a>`)}
      ${fact("Health", badge(p.state, { tone: TONE[p.state] ?? "default" }))}
      ${fact("Last check", checked ? time(checked) : none("never checked"))}
      ${fact("Last change", last ? html`${last.kind} to <span class="mono">${last.toVersion.slice(0, 12)}</span>` : none("none"))}
      ${last ? fact("Changed by", html`${f.names.get(last.by) ?? last.by} ${time(last.at)}`) : null}
    </dl>
    ${actions(p)}
  </section>`;
}

export function pinnedListPage(forges: PinnedView[], f: PinnedFacts): Html {
  return html`<div class="page-head"><h1>Pinned forges</h1></div>
    <p><a href="/deploy-to">Deploy a pinned forge</a></p>
    ${forges.length === 0 ? html`<p role="status">No pinned forge yet. Deploy one to a cloud account that allows writes.</p>` : forges.map((p) => forge(p, f))}`;
}
