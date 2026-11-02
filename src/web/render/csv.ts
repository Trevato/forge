/**
 * A CSV or TSV file as a table: the first thousand rows drawn on the server,
 * a sticky header, numbers right-aligned. Without JavaScript `?all=1` draws
 * more, up to a cap; the script below adds sort and filter and nothing else.
 */

import { escapeHtml, html, raw } from "../html.ts";
import { fileSize } from "../ui.ts";
import { numericColumns, parseCsv, type Delimiter } from "./csv-parse.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

/** Rows drawn by default, and by `?all=1` at most. */
export const ROW_WINDOW = 1_000;
export const ROW_CAP = 20_000;
/** Columns drawn, and cells (rows × columns) drawn, whatever the file holds. */
export const COLUMN_CAP = 200;
export const CELL_CAP = 200_000;

const NAMES: Record<Delimiter, string> = {
  ",": "comma",
  ";": "semicolon",
  "\t": "tab",
  "|": "pipe",
};

const cells = (tag: "th" | "td", row: string[], width: number, numeric: boolean[]): string => {
  let out = "";
  for (let c = 0; c < width; c++) {
    const v = row[c] ?? "";
    const cls = numeric[c] ? ' class="num"' : "";
    out += `<${tag}${cls}>${escapeHtml(v)}</${tag}>`;
  }
  return out;
};

export function csv(input: RenderInput): Rendered {
  const want = input.all ? ROW_CAP : ROW_WINDOW;
  const parsed = parseCsv(new TextDecoder().decode(input.body), {
    rows: want + 1,
    columns: COLUMN_CAP,
  });
  if ("error" in parsed) return { content: html``, lines: 0, fallback: parsed.error };
  const total = parsed.records - 1;
  const width = Math.min(parsed.columns, COLUMN_CAP);
  const numeric = numericColumns(parsed, width);
  // A wide table shrinks its row window so the page stays bounded.
  const shown = Math.min(total, want, Math.floor(CELL_CAP / width));
  const [head, ...rest] = parsed.rows;
  let body = "";
  for (let r = 0; r < shown; r++) body += `<tr>${cells("td", rest[r]!, width, numeric)}</tr>`;
  const href = input.pathHref ?? "";
  const wide =
    parsed.columns > width
      ? `Showing ${width.toLocaleString()} of ${parsed.columns.toLocaleString()} columns. `
      : "";
  const more =
    shown >= total && wide === ""
      ? ""
      : `<p class="muted small csv-more">${wide}${
          shown >= total ? "" : `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} rows. `
        }${
          shown >= total
            ? ""
            : !input.all && shown === Math.min(total, want)
              ? `<a id="csv-all" href="${escapeHtml(href)}?all=1">Show all ${total.toLocaleString()} rows</a>${
                  total > ROW_CAP ? ` (the page draws at most ${ROW_CAP.toLocaleString()})` : ""
                }`
              : "The rest is in the raw file."
        }</p>`;
  const content = html`<div class="card csv-view" data-csv>
    <div class="csv-tools" hidden>
      <input class="input" type="search" data-csv-filter placeholder="Filter rows" aria-label="Filter rows" autocomplete="off" />
      <span class="muted small num" data-csv-count aria-live="polite"></span>
    </div>
    <div class="csv-scroll">
      <table class="table" data-dense data-sticky-lead aria-label="${input.path.slice(input.path.lastIndexOf("/") + 1)} data">
        <thead><tr>${raw(cells("th", head!, width, numeric))}</tr></thead>
        <tbody>${raw(body)}</tbody>
      </table>
    </div>
    ${raw(more)}
  </div>`;
  return {
    content,
    lines: 0,
    summary: `${total.toLocaleString()} rows × ${parsed.columns.toLocaleString()} columns · ${NAMES[parsed.delimiter]}-separated · ${fileSize(input.size)}`,
  };
}

/** Whether a path can hold a table, so only those pages carry the script below. */
export const isCsvPath = (path: string): boolean => /\.(csv|tsv)$/i.test(path);

/** Sort on a header click, filter on typing. Trusted static code. */
export const csvJs = /* js */ `
(function () {
  var doc = document;
  function setup(box) {
    if (box.__csv) return;
    box.__csv = 1;
    var tools = box.querySelector('.csv-tools');
    if (tools) tools.hidden = false;
    var heads = box.querySelectorAll('thead th');
    for (var i = 0; i < heads.length; i++) {
      var th = heads[i];
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'csv-sort';
      while (th.firstChild) btn.appendChild(th.firstChild);
      th.appendChild(btn);
      th.setAttribute('aria-sort', 'none');
    }
  }
  function sort(th) {
    var box = th.closest('[data-csv]');
    var tbody = box.querySelector('tbody');
    var idx = Array.prototype.indexOf.call(th.parentNode.children, th);
    var num = th.classList.contains('num');
    var dir = th.getAttribute('aria-sort') === 'ascending' ? -1 : 1;
    var all = th.parentNode.children;
    for (var k = 0; k < all.length; k++) all[k].setAttribute('aria-sort', 'none');
    th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
    var rows = Array.prototype.slice.call(tbody.rows);
    var keys = rows.map(function (r) {
      var t = r.cells[idx] ? r.cells[idx].textContent : '';
      return num ? (t.trim() === '' ? null : parseFloat(t)) : t.toLowerCase();
    });
    var order = rows.map(function (_, j) { return j; });
    order.sort(function (a, b) {
      var x = keys[a], y = keys[b];
      if (x === null || y === null) return x === y ? a - b : x === null ? 1 : -1;
      return (x < y ? -1 : x > y ? 1 : a - b) * dir;
    });
    var frag = doc.createDocumentFragment();
    for (var m = 0; m < order.length; m++) frag.appendChild(rows[order[m]]);
    tbody.appendChild(frag);
  }
  function filter(input) {
    var box = input.closest('[data-csv]');
    var q = input.value.toLowerCase();
    var rows = box.querySelector('tbody').rows;
    var shown = 0;
    for (var i = 0; i < rows.length; i++) {
      var hit = q === '' || rows[i].textContent.toLowerCase().indexOf(q) !== -1;
      rows[i].hidden = !hit;
      if (hit) shown++;
    }
    var out = box.querySelector('[data-csv-count]');
    if (out) out.textContent = q === '' ? '' : shown + ' of ' + rows.length + ' rows';
  }
  function scan() {
    var boxes = doc.querySelectorAll('[data-csv]');
    for (var i = 0; i < boxes.length; i++) setup(boxes[i]);
  }
  doc.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-csv] .csv-sort');
    if (b) sort(b.parentNode);
  });
  doc.addEventListener('input', function (e) {
    if (e.target.matches && e.target.matches('[data-csv-filter]')) filter(e.target);
  });
  scan();
  // The code view swaps its pane in place and says so.
  doc.addEventListener('code:swap', scan);
})();
`;
