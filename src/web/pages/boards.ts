/**
 * Boards, for a forge admin who is a person: `GET /boards/data` lists the
 * sources and their columns, and draws one query as a line chart with the
 * table of its points under it. The query is the URL (GET params), so a
 * query is a link. Each point links to the rows behind it: the same query
 * narrowed to that point's window and listed by the source's first column.
 * Anyone else gets the not-found page.
 */
import { lineChart } from "../../boards/chart.ts";
import { runQuery, type Query } from "../../boards/query.ts";
import { SOURCES } from "../../boards/sources.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage } from "../chrome.ts";
import { html, raw } from "../html.ts";
import { page } from "../layout.ts";
import { btn, card, empty } from "../ui.ts";

const BUCKET_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;
const AGGREGATES = ["count", "sum", "avg", "max"] as const;
const OPS = ["eq", "ne", "lt", "lte", "gt", "gte"] as const;
const MAX_PARAM = 256;

type Bucket = keyof typeof BUCKET_MS;
const isBucket = (s: string): s is Bucket => Object.hasOwn(BUCKET_MS, s);

/** What the URL asks for: plain strings, bounded; `runQuery` judges them. */
function readParams(url: URL) {
  const get = (k: string, d = "") => (url.searchParams.get(k) ?? d).slice(0, MAX_PARAM);
  return {
    source: get("source", "runs"),
    aggregate: get("aggregate", "count"),
    column: get("column"),
    by: get("by", "day"),
    from: get("from"),
    to: get("to"),
    fcolumn: get("fcolumn"),
    fop: get("fop", "eq"),
    fvalue: get("fvalue"),
    gcolumn: get("gcolumn"),
    gvalue: get("gvalue"),
    rows: get("rows") === "1" ? "1" : "",
  };
}
type Params = ReturnType<typeof readParams>;

function toQuery(p: Params): Query {
  const src = Object.hasOwn(SOURCES, p.source) ? SOURCES[p.source]! : undefined;
  const q: Query = { source: p.source, aggregate: p.aggregate };
  if (p.column !== "") q.column = p.column;
  if (p.from !== "") q.from = p.from;
  if (p.to !== "") q.to = p.to;
  q.groupBy = isBucket(p.by) ? { bucket: p.by } : p.by;
  const filter: NonNullable<Query["filter"]> = [];
  const add = (column: string, op: string, value: string) => {
    const numeric = src?.columns[column] === "number";
    filter.push({ column, op, value: numeric ? Number(value) : value });
  };
  if (p.fcolumn !== "") add(p.fcolumn, p.fop, p.fvalue);
  if (p.gcolumn !== "") add(p.gcolumn, "eq", p.gvalue);
  if (filter.length > 0) q.filter = filter;
  return q;
}

const link = (p: Params) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== "") s.set(k, v);
  return `/boards/data?${s}`;
};

/**
 * The rows behind one point, or null when the point has no rows to name (a
 * null group). The user's own filter stays; a column group joins it as a
 * second filter (`gcolumn`/`gvalue`), a bucket group as a time window. The
 * rows view counts rows by the source's first column, so it lists that
 * column's values, not whole rows.
 */
function behind(p: Params, group: string | number | null): string | null {
  const first = Object.keys(SOURCES[p.source]!.columns)[0]!;
  const rows = { ...p, rows: "1", by: first, aggregate: "count", column: "" };
  if (!isBucket(p.by)) {
    if (group === null) return null;
    return link({ ...rows, gcolumn: p.by, gvalue: String(group) });
  }
  if (typeof group !== "string") return null;
  const start = new Date(group);
  return link({
    ...rows,
    from: start.toISOString(), to: new Date(start.getTime() + BUCKET_MS[p.by]).toISOString(),
  });
}

const option = (value: string, label: string, selected: boolean) =>
  html`<option value="${value}" ${selected ? raw("selected") : null}>${label}</option>`;

// GET /boards/data
export function boardsPage(ctx: Ctx): Response {
  const user = ctx.auth.user;
  if (user?.isAdmin !== true || user.kind === "agent") return notFoundPage(ctx);
  const p = readParams(ctx.url);
  const src = Object.hasOwn(SOURCES, p.source) ? SOURCES[p.source]! : undefined;
  const answer = runQuery(ctx.app.db, toQuery(p), { repoIds: "all" });
  const cols = src ? Object.keys(src.columns) : [];

  const sources = card(
    html`<ul class="list">
      ${Object.entries(SOURCES).map(
        ([name, s]) => html`<li class="row">
          <a href="${link({ ...p, source: name, by: "day", column: "", fcolumn: "", fvalue: "", gcolumn: "", gvalue: "", rows: "" })}"><strong>${name}</strong></a>
          <span class="muted small mono">${Object.entries(s.columns).map(([c, t]) => `${c}:${t}`).join(" ")}</span>
        </li>`,
      )}
    </ul>`,
    { head: html`<h2>Sources</h2>`, pad: false },
  );

  const form = card(
    html`<form method="get" action="/boards/data" class="row-actions">
      <select class="input" name="source" aria-label="Source">
        ${Object.keys(SOURCES).map((n) => option(n, n, n === p.source))}
      </select>
      <select class="input" name="aggregate" aria-label="Aggregate">
        ${AGGREGATES.map((a) => option(a, a, a === p.aggregate))}
      </select>
      <select class="input" name="column" aria-label="Column to aggregate">
        ${option("", "(rows)", p.column === "")}
        ${cols.filter((c) => src!.columns[c] === "number").map((c) => option(c, c, c === p.column))}
      </select>
      <select class="input" name="by" aria-label="Group by">
        ${(Object.keys(BUCKET_MS) as Bucket[]).map((b) => option(b, `per ${b}`, b === p.by))}
        ${cols.map((c) => option(c, `by ${c}`, c === p.by))}
      </select>
      <input class="input mono" name="from" value="${p.from}" placeholder="from 2026-10-01" aria-label="From" maxlength="${MAX_PARAM}" />
      <input class="input mono" name="to" value="${p.to}" placeholder="to 2026-10-08" aria-label="To" maxlength="${MAX_PARAM}" />
      <select class="input" name="fcolumn" aria-label="Filter column">
        ${option("", "(no filter)", p.fcolumn === "")}
        ${cols.map((c) => option(c, c, c === p.fcolumn))}
      </select>
      <select class="input" name="fop" aria-label="Filter operator">
        ${OPS.map((o) => option(o, o, o === p.fop))}
      </select>
      <input class="input mono" name="fvalue" value="${p.fvalue}" placeholder="value" aria-label="Filter value" maxlength="${MAX_PARAM}" />
      ${btn("Draw", { variant: "primary" })}
    </form>`,
    { head: html`<h2>Query</h2>` },
  );

  let result;
  if (!answer.ok) {
    result = empty({ icon: "activity", title: "That query was refused", note: answer.error });
  } else if (answer.rows.length === 0) {
    result = empty({ icon: "activity", title: "No rows", note: "Nothing matches this query." });
  } else {
    const hrefs = answer.rows.map((r) => (p.rows === "" ? behind(p, r.group) : null));
    const points = answer.rows.map((r, i) => ({
      label: String(r.group ?? "all"),
      value: r.value ?? 0,
      ...(hrefs[i] ? { href: hrefs[i]! } : {}),
    }));
    const chart =
      p.rows === ""
        ? html`<div class="chart-box">${raw(lineChart(points, `${p.aggregate} of ${p.source}`))}</div>`
        : html`<p class="muted small">The rows behind a point, as the values of ${cols[0] ?? ""} with how many rows have each. <a href="${link({ ...p, rows: "" })}">Back to the chart</a>.</p>`;
    result = html`${chart}
      <table class="table">
        <thead><tr><th scope="col">${p.by}</th><th scope="col" class="num">${p.aggregate}</th></tr></thead>
        <tbody>
          ${answer.rows.map(
            (r, i) => html`<tr>
              <td class="mono">${hrefs[i] ? html`<a href="${hrefs[i]!}">${points[i]!.label}</a>` : points[i]!.label}</td>
              <td class="num mono">${String(r.value ?? "")}</td>
            </tr>`,
          )}
        </tbody>
      </table>`;
  }

  return page({
    ctx,
    title: "Boards",
    body: html`<div class="page-head"><h1>Boards</h1></div>
      ${form} ${card(result, { head: html`<h2>${p.source}</h2>`, extra: "boards-result" })} ${sources}`,
  });
}
