/**
 * /data: the SQLite files the viewer may see (`data/sources.ts`), the
 * tables in one, and a page of a table's rows, secrets masked. Anyone with
 * no door to the data (a guest, a reader) gets the not-found page; an admin
 * or an app's writer gets the page, with an empty state until a file exists.
 */

import { PAGE_SIZE, rows, tables } from "../../data/browse.ts";
import { findSource, listSources, maySeeData } from "../../data/sources.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { notFoundPage, pageHead, signInFirst } from "../chrome.ts";
import { html } from "../html.ts";
import { page } from "../layout.ts";
import { empty, pager, row } from "../ui.ts";

const PURPOSE = "The SQLite files you may read, their tables and rows; secrets are masked.";

const href = (params: Record<string, string | number>): string =>
  `/data?${new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]))}`;

// GET /data[?source=<id>[&table=<name>[&page=<n>]]]
export function dataPage(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const viewer = ctx.auth.user;
  if (!viewer) return signInFirst(ctx);
  const { db, config } = ctx.app;
  if (!maySeeData(db, viewer)) return notFoundPage(ctx);
  const q = ctx.url.searchParams;
  const all = listSources(db, config.dataDir, viewer);
  const chosen = q.get("source");
  const source = chosen === null ? undefined : findSource(db, config.dataDir, viewer, chosen);
  if (chosen !== null && !source) return notFoundPage(ctx);

  let body = html`${pageHead("Data", { sub: PURPOSE })}
    ${all.length === 0
      ? empty({
          title: "No database yet",
          note: "An app's SQLite files appear here once it has written one under its data directory.",
        })
      : html`<ul class="list">
          ${all.map((s) => row({ href: href({ source: s.id }), title: s.label, current: s.id === source?.id }))}
        </ul>`}`;

  if (source) {
    const list = tables(source);
    const name = q.get("table");
    const shown = name === null ? undefined : rows(source, name, { page: Number(q.get("page") ?? 0) });
    if (name !== null && !shown) return notFoundPage(ctx);
    body = html`${body}
      <h2>${source.label}</h2>
      <ul class="list">
        ${list.map((t) =>
          row({
            href: href({ source: source.id, table: t.name }),
            title: t.name,
            trail: html`${String(t.rows)} rows`,
            current: t.name === name,
          }),
        )}
      </ul>`;
    if (shown && name !== null) {
      const more = (shown.page + 1) * PAGE_SIZE < shown.total;
      body = html`${body}
        <h2>${name}</h2>
        <div class="table-scroll">
          <table class="table" data-dense>
            <caption class="sr-only">${name} in ${source.label}</caption>
            <thead><tr>${shown.columns.map((c) => html`<th scope="col">${c}</th>`)}</tr></thead>
            <tbody>
              ${shown.rows.map((r) => html`<tr>${r.map((v) => html`<td>${v === null ? "" : String(v)}</td>`)}</tr>`)}
            </tbody>
          </table>
        </div>
        ${pager({
          note: `${shown.total} rows`,
          words: { prev: "Previous page", next: "Next page" },
          ...(shown.page > 0 ? { prev: href({ source: source.id, table: name, page: shown.page - 1 }) } : {}),
          ...(more ? { next: href({ source: source.id, table: name, page: shown.page + 1 }) } : {}),
        })}`;
    }
  }
  const rendering = performance.now();
  const response = page({ ctx, title: "Data", body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
