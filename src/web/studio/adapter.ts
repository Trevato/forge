/**
 * The adapter card on an app's studio page (#10037, docs/ADAPTERS.md): for an
 * app whose `forge.json` declares an `adapter`, its source, its last pull
 * (state, counts, when), when the next is due, and the cursor of the last good
 * pull. The read is two limit-1 walks of `pull_run_app` and `pull_run_app_ok`
 * (`test/hot-reads-indexed.test.ts`). Every value is the adapter's own text
 * and goes through `html`, which escapes it. The wording is
 * `adapterFactRows`, shared with the terminal; this module adds only markup.
 */
import type { PullRunLine } from "../../apps/pull.ts";
import type { App } from "../../app.ts";
import type { AppRecord } from "../../core/apps.ts";
import { NO_RUNS_WORDS, adapterFactRows, pullRunWords, adapterFactsOf, everyWords, type AdapterFacts, type FactPart } from "../../apps/adapter_facts.ts";
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
    ${runsList(facts.runs ?? [])}
  </section>`;
}

/** Whether the sync is healthy over time: the heading is always there, the runs or one muted line under it. */
function runsList(runs: readonly PullRunLine[]): Html {
  return html`<h3>Pull runs</h3>
    ${runs.length === 0
      ? html`<p class="muted">${NO_RUNS_WORDS}</p>`
      : html`<ul class="pull-runs">
      ${runs.map((r) => html`<li class="break">${time(r.at)} ${badge(r.state, { variant: "outline" })} ${pullRunWords(r)}</li>`)}
    </ul>`}`;
}

/** The section for an app that declares an adapter on its default branch; null for any other. */
export async function adapterCard(app: App, record: AppRecord): Promise<Html | null> {
  const facts = await adapterFactsOf(app, record);
  return facts === undefined ? null : adapterCardView(facts);
}
