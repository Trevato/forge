/**
 * Hosts the app's cells were refused, said where its owner looks (#10456):
 * one line per host, "Blocked: huggingface.co (14 tries, last 2 min ago)",
 * with one Allow beside it and a quiet Ignore.
 */

import type { BlockedView } from "../../actions/egress_refused.ts";
import { html, type Html } from "../html.ts";
import { btn, row } from "../ui.ts";

export function blockedNote(base: string, view: BlockedView): Html | null {
  if (view.rows.length === 0 && view.liveOnly.length === 0) return null;
  const at = (destination: string, verb: string) =>
    `${base}/settings/app/blocked/${encodeURIComponent(destination)}/${verb}`;
  const items = view.rows.map((r) =>
    row({
      title: html`${r.line}`,
      meta: r.private
        ? html`<span class="muted small">A private destination: only a site admin allows it.</span>`
        : html``,
      trail: html`<div class="row-fields">
        ${r.private && !view.canAllowPrivate
          ? html``
          : html`<form method="post" action="${at(r.destination, "allow")}">
              ${btn("Allow", { size: "sm" })}
            </form>`}
        <form method="post" action="${at(r.destination, "ignore")}">
          ${btn("Ignore", { size: "sm", variant: "ghost" })}
        </form>
      </div>`,
    }),
  );
  const live = view.liveOnly.map((e) =>
    row({
      title: html`Allowed now, not in forge.json: ${e}`,
      meta: html`<span class="muted small">Add it to forge.json egress so the repository says it.</span>`,
    }),
  );
  return html`<section class="settings-block" id="blocked">
    <ul class="list setting-list">
      ${items}${live}
    </ul>
  </section>`;
}
