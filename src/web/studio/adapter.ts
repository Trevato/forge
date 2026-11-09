/**
 * The adapter card on an app's studio page (#10037, docs/ADAPTERS.md): for an
 * app whose `forge.json` declares an `adapter`, its source, its last pull
 * (state, counts, when), when the next is due, and the cursor of the last good
 * pull. The read is two limit-1 walks of `pull_run_app` and `pull_run_app_ok`
 * (`test/hot-reads-indexed.test.ts`). Every value is the adapter's own text
 * and goes through `html`, which escapes it. The wording is
 * `adapterFactRows`, shared with the terminal; this module adds only markup.
 */
import type { App } from "../../app.ts";
import type { AppRecord } from "../../core/apps.ts";
import { adapterFactRows, adapterFactsOf, everyWords, type AdapterFacts, type FactPart } from "../../apps/adapter_facts.ts";
import { html, type Html } from "../html.ts";
import { badge, time } from "../ui.ts";

export { everyWords, type AdapterFacts };

function part(p: FactPart): Html {
  switch (p.kind) {
    case "time":
      return time(p.iso);
    case "badge":
      return badge(p.text, { variant: "outline" });
    case "muted":
      return html`<span class="muted">${p.text}</span>`;
    case "code":
      return html`<code>${p.text}</code>`;
    case "text":
      return html`${p.text}`;
  }
}

/** The adapter's facts as plain dl rows under an h2 (principles 6 and 7: a fact is a row, not a card). */
export function adapterCardView(facts: AdapterFacts, now: number = Date.now()): Html {
  return html`<section class="adapter">
    <h2>Adapter</h2>
    <dl>
      ${adapterFactRows(facts, now).map((row) => html`<dt>${row.label}</dt>
      <dd>${row.parts.map(part)}</dd>`)}
    </dl>
  </section>`;
}

/** The section for an app that declares an adapter on its default branch; null for any other. */
export async function adapterCard(app: App, record: AppRecord): Promise<Html | null> {
  const facts = await adapterFactsOf(app, record);
  return facts === undefined ? null : adapterCardView(facts);
}
