/**
 * The spend breakdown (`actions/spend.ts`) as tables: one per attribution —
 * credential, app, agent, issue, run kind — each row the last 5 hours,
 * today and the week side by side, then the week's ten costliest runs.
 * Shared by the board and the Subscriptions page, so they never disagree.
 * Every name is escaped by `html`; numbers are formatted here, once.
 */

import type { Spend, SpendLine, SpanName } from "../../actions/spend.ts";
import { fleetGraphHref } from "../fleet-graph.ts";
import { html, type Html } from "../html.ts";

const usd = (n: number): string => `$${n.toFixed(2)}`;
/** Whole tokens, shortened past a thousand: 32 120 → 32.1k. */
export const tokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}k`
      : String(n);

const SPAN_WORDS: Readonly<Record<SpanName, string>> = {
  "5h": "last 5 h",
  today: "today",
  week: "7 days",
};

type Dimension = "byCredential" | "byApp" | "byAgent" | "byIssue" | "byKind";
const DIMENSIONS: readonly [Dimension, string][] = [
  ["byCredential", "Credential"],
  ["byApp", "App"],
  ["byAgent", "Agent"],
  ["byIssue", "Issue"],
  ["byKind", "Run kind"],
];

/** One attribution's rows, each span's cost side by side, the week's tokens. */
function table(spend: Spend, dim: Dimension, title: string): Html {
  const names: string[] = [];
  const at = new Map<string, Map<SpanName, SpendLine>>();
  for (const s of spend.spans)
    for (const line of s[dim]) {
      if (!at.has(line.name)) {
        names.push(line.name);
        at.set(line.name, new Map());
      }
      at.get(line.name)!.set(s.span, line);
    }
  // The week's order: most spent first.
  const week = (n: string): number => at.get(n)!.get("week")?.costUsd ?? 0;
  names.sort((a, b) => week(b) - week(a));
  return html`<div class="table-scroll">
    <table class="table" data-dense data-by="${dim}" aria-label="${title}">
    <thead>
      <tr>
        <th scope="col">${title}</th>
        ${spend.spans.map(
          (s) => html`<th scope="col" class="num">${SPAN_WORDS[s.span]}</th>`,
        )}
        <th scope="col" class="num">runs, 7 d</th>
        <th scope="col" class="num">tokens in / out, 7 d</th>
      </tr>
    </thead>
    <tbody>
      ${names.length === 0
        ? html`<tr>
            <td colspan="${spend.spans.length + 3}" class="muted">
              Nothing spent in the last 7 days.
            </td>
          </tr>`
        : names.map((n) => {
            const of = at.get(n)!;
            const w = of.get("week");
            return html`<tr>
              <th scope="row">${dim === "byApp" && n.includes("/")
                ? html`<a href="${fleetGraphHref([n])}" title="This app on the fleet graph">${n}</a>`
                : n}</th>
              ${spend.spans.map(
                (s) =>
                  html`<td class="num">${usd(of.get(s.span)?.costUsd ?? 0)}</td>`,
              )}
              <td class="num">${String(w?.units ?? 0)}</td>
              <td class="num">
                ${tokens(w?.tokensIn ?? 0)} / ${tokens(w?.tokensOut ?? 0)}
              </td>
            </tr>`;
          })}
    </tbody>
  </table>
    </div>`;
}

/** The whole breakdown: totals, five tables, the top runs. */
export function spendView(spend: Spend): Html {
  return html`<div class="spend stack">
    <p class="num">
      ${spend.spans.map(
        (s, i) =>
          html`${i > 0 ? " — " : null}<span
            ><b>${usd(s.total.costUsd)}</b> ${SPAN_WORDS[s.span]} ·
            ${String(s.total.units)} runs · ${tokens(s.total.tokensIn)} in /
            ${tokens(s.total.tokensOut)} out</span
          >`,
      )}
    </p>
    <p><a href="${fleetGraphHref([])}">Fleet graph</a></p>
    ${DIMENSIONS.map(([dim, title]) => table(spend, dim, title))}
    <p class="muted" id="spend-top">The 10 costliest runs, 7 days</p>
    <div class="table-scroll">
    <table class="table" data-dense data-by="top" aria-labelledby="spend-top">
      <thead>
        <tr>
          <th scope="col">Run</th>
          <th scope="col">Credential</th>
          <th scope="col">Agent</th>
          <th scope="col">Issue</th>
          <th scope="col">Kind</th>
          <th scope="col" class="num">Cost</th>
          <th scope="col" class="num">tokens in / out</th>
        </tr>
      </thead>
      <tbody>
        ${spend.top.map(
          (t) =>
            html`<tr data-outcome="${t.outcome}">
              <th scope="row">
                <a href="/${t.app}/runs/${t.runId}">${t.app}</a>${t.outcome ===
                "running"
                  ? html` <i class="muted">running</i>`
                  : null}
              </th>
              <td>${t.credential}</td>
              <td>${t.agent}</td>
              <td>${t.issue}</td>
              <td>${t.kind}</td>
              <td class="num">${usd(t.costUsd)}</td>
              <td class="num">${tokens(t.tokensIn)} / ${tokens(t.tokensOut)}</td>
            </tr>`,
        )}
      </tbody>
    </table>
    </div>
    <p class="muted small">
      US dollars at list price, as Claude Code reports them; a running session's
      tokens count as they arrive, its cost when it reports one. "Last 5 h" is
      the last five hours, not any one account's window — each credential's own
      windows are shown with it.
    </p>
  </div>`;
}
