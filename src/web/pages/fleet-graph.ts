/**
 * The fleet graph's pages: `GET /fleet/graph` (the chart, the table beside
 * it and the selection that drew them, all in the URL), `GET
 * /fleet/graph/live` (the same section alone, which the page refetches to
 * redraw) and `GET /fleet/graph.csv` (every bucket as a table file).
 *
 * The selection is `?repo=owner/name`, repeated; absent, it is every
 * repository the viewer may write that spent anything in the last 14 days.
 * Signed in only: spend is an owner's fact (`actions/fleet-graph.ts`).
 */

import {
  fleetSelection,
  readFleetGraph,
  type FleetGraph,
} from "../../actions/fleet-graph.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import type { Ctx } from "../../http/context.ts";
import { signInFirst } from "../chrome.ts";
import {
  fleetGraphClientJs,
  fleetGraphSection,
  selectionQuery,
} from "../fleet-graph.ts";
import { html } from "../html.ts";
import { fragment, page } from "../layout.ts";
import { btn, field } from "../ui.ts";

/** The selection from the URL, or the refusal's words. */
function selection(ctx: Ctx) {
  return fleetSelection(ctx.url.searchParams.getAll("repo"));
}

/** GET /fleet/graph */
export function fleetGraphPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  const asked = selection(ctx);
  const graph = asked.ok
    ? timePhase(ctx.request, "graph", () =>
        readFleetGraph(ctx.app, user, asked.value),
      )
    : undefined;
  const rendering = performance.now();
  const q = graph === undefined ? "" : selectionQuery(graph);
  const names = ctx.url.searchParams.getAll("repo").join(" ");
  const response = page(
    {
      ctx,
      title: "Fleet graph",
      description:
        "Spend and runs over time for a selection of repositories, by hour and by day.",
      wide: true,
      body: html`<div class="page-head">
          <h1>Fleet graph</h1>
          <span class="spacer"></span>
          ${btn("Table file", {
            href: `/fleet/graph.csv${q === "" ? "" : `?${q}`}`,
            size: "sm",
            icon: "download",
          })}
          ${btn("JSON", {
            href: `/api/v1/fleet/graph${q === "" ? "" : `?${q}`}`,
            size: "sm",
            variant: "secondary",
          })}
          ${btn("Rows", {
            href: "/fleet",
            size: "sm",
            variant: "secondary",
          })}
          <p class="muted">
            What a selection of repositories spent and how many runs ended,
            hour by hour and day by day.
          </p>
        </div>
        <form method="get" action="/fleet/graph" class="field-row mb">
          ${field({
            label: "Repositories",
            name: "repo",
            id: "fleet-repos",
            ...(asked.ok ? {} : { error: asked.error }),
            value: names,
            placeholder:
              "owner/name owner/name — empty is everything you can write that spent",
            autocomplete: "off",
            mono: true,
            spellcheck: false,
          })}
          ${btn("Draw", { type: "submit", variant: "secondary" })}
        </form>
        ${graph === undefined ? null : fleetGraphSection(graph)}`,
      scriptJs: fleetGraphClientJs,
    },
    graph === undefined ? 422 : 200,
  );
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}

/** GET /fleet/graph/live — the section alone, for the redraw. */
export function fleetGraphLive(ctx: Ctx): Response {
  const user = ctx.auth.user;
  if (!user) return fragment(html``, { status: 404 });
  const asked = selection(ctx);
  if (!asked.ok) return fragment(html``, { status: 422 });
  return fragment(fleetGraphSection(readFleetGraph(ctx.app, user, asked.value)), {
    request: ctx.request,
  });
}

/**
 * Every bucket of both windows as rows: window, bucket start, repository
 * (or the folded series' label), runs, failed, spend in USD to the cent's
 * hundredth — what the bars were drawn from, for a spreadsheet.
 */
export function fleetGraphCsvText(graph: FleetGraph): string {
  const cell = (v: string): string =>
    /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const rows: string[][] = [
    ["window", "bucket_start_utc", "series", "runs", "failed", "cost_usd"],
  ];
  for (const w of graph.windows)
    for (const b of w.buckets)
      graph.series.forEach((s, i) =>
        rows.push([
          w.name,
          b.start,
          s.label,
          String(b.runs[i] ?? 0),
          String(b.failed[i] ?? 0),
          (b.costUsd[i] ?? 0).toFixed(4),
        ]),
      );
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** GET /fleet/graph.csv */
export function fleetGraphCsv(ctx: Ctx): Response {
  const user = ctx.auth.user;
  if (!user) return signInFirst(ctx);
  const asked = selection(ctx);
  if (!asked.ok)
    return new Response(`${asked.error}\n`, {
      status: 422,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  const graph = readFleetGraph(ctx.app, user, asked.value);
  return new Response(fleetGraphCsvText(graph), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="fleet-graph.csv"',
      "cache-control": "private, no-store",
    },
  });
}
