/**
 * The data page's answer, drawn: from a query's rows to the chart's markup,
 * the table of its points, the link behind each point and the few facts that
 * stand out. Pure (rows in, strings out), so whoever reads the rows off the
 * serving thread draws them there too (`flow/pages_read.ts`): a thousand
 * points are a thousand links and a thousand table rows, and none of that is
 * built on a request.
 */
import { html } from "../web/html.ts";
import { drawChart, formatValue, grouped, sayLabels } from "./chart.ts";
import { columnWords } from "./guide.ts";
import { cellsOf } from "./panel_data.ts";
import { BUCKET_MS, isBucket, type Params } from "./params.ts";
import type { Answer, Row } from "./query.ts";
import { SOURCES } from "./sources.ts";

/** A query as its address on the data page. */
export const dataLink = (p: Params): string => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== "") s.set(k, v);
  return `/boards/data?${s}`;
};

/**
 * The rows behind one point, or null when the point has no rows to name (a
 * null group). The user's own filter stays; a column group joins it as a
 * second filter (`gcolumn`/`gvalue`), a bucket group as a time window. The
 * rows view counts rows by the source's first column, so it lists that
 * column's values, not whole rows. The part every point shares is built once.
 */
function behindOf(p: Params): (row: Row) => string | null {
  const first = Object.keys(SOURCES[p.source]!.columns)[0]!;
  const base = dataLink({ ...p, rows: "1", by: first, aggregate: "count", column: "", series: "", from: "", to: "", gcolumn: "", gvalue: "" });
  const and = (k: string, v: string): string => `&${k}=${encodeURIComponent(v)}`;
  if (!isBucket(p.by)) {
    const window = (p.from === "" ? "" : and("from", p.from)) + (p.to === "" ? "" : and("to", p.to));
    // A column group and a series would be two filters beside the user's; the rows view says one.
    return (row) => (row.group === null || row.series !== undefined ? null : `${base}${window}${and("gcolumn", p.by)}${and("gvalue", String(row.group))}`);
  }
  const span = BUCKET_MS[p.by];
  return (row) => {
    if (typeof row.group !== "string" || row.series === null) return null;
    const start = new Date(row.group);
    if (Number.isNaN(start.getTime())) return null;
    const series = row.series === undefined ? "" : `${and("gcolumn", p.series)}${and("gvalue", String(row.series))}`;
    return `${base}${and("from", start.toISOString())}${and("to", new Date(start.getTime() + span).toISOString())}${series}`;
  };
}

/** One figure of what stands out: its name, its value, where it is, and the rows behind it. */
export interface Fact {
  readonly label: string;
  readonly value: string;
  readonly note: string;
  readonly href: string;
}

/** The answer as the page frames it. `chart` and `facts` are null in the rows view; `points` is 0 when nothing matched. */
export type AnswerDrawn =
  | { ok: true; points: number; chart: string | null; table: string; facts: readonly Fact[] | null; linked: boolean }
  | { ok: false; error: string };

const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);
const count = (n: number): string => grouped(n, 3);

export function drawAnswer(p: Params, answer: Answer, title: string): AnswerDrawn {
  if (!answer.ok) return { ok: false, error: answer.error };
  const rowsView = p.rows !== "";
  if (answer.rows.length === 0) return { ok: true, points: 0, chart: null, table: "", facts: null, linked: false };
  const behind = rowsView ? () => null : behindOf(p);
  const hrefs = answer.rows.map(behind);
  const points = cellsOf(answer.rows, hrefs);
  const split = answer.rows[0]?.series !== undefined;
  const say = sayLabels(points.map((c) => c.label));
  const where = (i: number): string => `${say(points[i]!.label)}${split ? `, ${points[i]!.series ?? ""}` : ""}`;
  const table = html`<div class="table-scroll"><table class="table" data-dense id="points">
      <thead><tr><th scope="col">${cap(columnWords(p.by))}</th>${split ? html`<th scope="col">${cap(columnWords(p.series))}</th>` : null}<th scope="col" class="num">${cap(p.aggregate)}</th></tr></thead>
      <tbody>
        ${answer.rows.map(
          (r, i) => html`<tr>
            <td ${rowsView ? html`class="mono"` : null}>${hrefs[i] ? html`<a href="${hrefs[i]!}">${say(points[i]!.label)}</a>` : say(points[i]!.label)}</td>
            ${split ? html`<td>${points[i]!.series ?? ""}</td>` : null}
            <td class="num">${r.value === null ? "" : count(r.value)}</td>
          </tr>`,
        )}
      </tbody>
    </table></div>`.text;
  if (rowsView) return { ok: true, points: points.length, chart: null, table, facts: null, linked: false };
  // The facts name what stands out in the answer: where it is now, its highest and its lowest.
  let hi = 0;
  let lo = 0;
  points.forEach((c, i) => {
    if (c.value > points[hi]!.value) hi = i;
    if (c.value < points[lo]!.value) lo = i;
  });
  const last = points.length - 1;
  const at = (i: number): string => hrefs[i] ?? "#points";
  const sums = p.aggregate === "count" || p.aggregate === "sum";
  const facts: Fact[] = [
    // "Latest" is true of a series over time alone; groups of anything else are counted.
    split || !isBucket(p.by)
      ? { label: split ? "Points" : "Groups", value: count(points.length), note: split ? `across ${count(new Set(points.map((c) => c.series)).size)} series` : `one for each ${columnWords(p.by)}`, href: "#points" }
      : { label: "Latest", value: formatValue(points[last]!.value), note: where(last), href: at(last) },
    { label: "Highest", value: formatValue(points[hi]!.value), note: where(hi), href: at(hi) },
    { label: "Lowest", value: formatValue(points[lo]!.value), note: where(lo), href: at(lo) },
    sums
      ? { label: "In all", value: formatValue(points.reduce((n, c) => n + c.value, 0)), note: `over ${count(points.length)} ${points.length === 1 ? "point" : "points"}`, href: "#points" }
      : { label: "Points", value: count(points.length), note: `from ${say(points[0]!.label)} to ${say(points[last]!.label)}`, href: "#points" },
  ];
  return { ok: true, points: points.length, chart: drawChart(p.chart, points, title), table, facts, linked: hrefs.some((h) => h !== null) };
}
