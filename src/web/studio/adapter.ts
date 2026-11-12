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
import type { Repo } from "../../core/repos.ts";
import type { AppRecord } from "../../core/apps.ts";
import { NO_RUNS_WORDS, adapterFactRows, pullRunWords, adapterFactsOf, everyWords, type AdapterFacts, type FactPart } from "../../apps/adapter_facts.ts";
import { pullNow, PULL_NOW_REFUSALS, type PullNowError } from "../../actions/app_pull.ts";
import { requireWriter } from "../../actions/access.ts";
import { getAppByRepo } from "../../core/apps.ts";
import type { Ctx } from "../../http/context.ts";
import { loadRepo, notFoundPage, repoBase } from "../chrome.ts";
import { readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { redirect } from "../layout.ts";
import { badge, btn, time } from "../ui.ts";

/** What a writer is offered under the rows: the form's address, and the sentence of a refused pull, if the last one was. */
export interface PullOffer {
  readonly action: string;
  readonly refusal?: string | undefined;
}

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
export function adapterCardView(facts: AdapterFacts, now: number = Date.now(), pull?: PullOffer): Html {
  return html`<section class="adapter">
    <h2>Adapter</h2>
    <dl>
      ${adapterFactRows(facts, now).map((row) => html`<dt>${row.label}</dt>
      <dd>${row.parts.map(part)}</dd>`)}
    </dl>${pull === undefined
      ? null
      : html`
    <form method="post" action="${pull.action}">${btn("Pull now", { size: "sm" })}</form>${pull.refusal === undefined
      ? null
      : html`
    <p class="muted small">${pull.refusal}</p>`}`}
    ${runsList(facts.runs ?? [])}
  </section>`;
}

/** The refusal a `?pull=` code names, or none: only the codes `pullNow` can refuse with are believed. */
export function pullRefusalOf(code: string | null): string | undefined {
  return code !== null && Object.hasOwn(PULL_NOW_REFUSALS, code) ? PULL_NOW_REFUSALS[code as PullNowError] : undefined;
}

/** The section for an app that declares an adapter on its default branch; null for any other. A writer is offered Pull now. */
export async function adapterCard(ctx: Ctx, record: AppRecord, repo: Repo): Promise<Html | null> {
  const facts = await adapterFactsOf(ctx.app, record);
  if (facts === undefined) return null;
  const base = repoBase(repo);
  const writer = requireWriter(ctx.app, ctx.auth.user, repo).ok;
  return adapterCardView(
    facts,
    Date.now(),
    writer ? { action: `${base}/app/pull`, refusal: pullRefusalOf(ctx.url.searchParams.get("pull")) } : undefined,
  );
}

// POST /:owner/:name/app/pull — pull now, then back to the app page; a refusal rides as `?pull=<code>`.
export async function adapterPull(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo || !requireWriter(ctx.app, ctx.auth.user, repo).ok || !getAppByRepo(ctx.app.db, repo.id)) return notFoundPage(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const pulled = await pullNow(ctx.app, ctx.auth.user, repo);
  const back = repoBase(repo); // /app answers 302 to here; the query would be lost
  return redirect(pulled.ok ? back : `${back}?pull=${pulled.error}`, { url: ctx.url, forgeUrl: ctx.app.config.url });
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
