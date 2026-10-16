/**
 * GET /system, for a forge admin who is a person: the forge's resident
 * memory (RSS) beside its JS heap, hourly for the last 24 h (#2151). RSS
 * climbing while the heap stays flat is native memory growth. Drawn on the
 * server as SVG, with the hours under it as a table. Anyone else gets 403.
 */
import { drawChart } from "../../boards/chart.ts";
import { canSeeMemory, memoryHours } from "../../boards/memory.ts";
import type { Ctx } from "../../http/context.ts";
import { html, raw } from "../html.ts";
import { page } from "../layout.ts";
import { btn, card, empty } from "../ui.ts";

const mib = (n: number) => `${(n / 1_048_576).toFixed(1)} MiB`;
const hhmm = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");

const forbiddenPage = (ctx: Ctx) =>
  page(
    {
      ctx,
      title: "Forbidden",
      body: html`<div class="page-head"><h1>403</h1></div>
        ${empty({ icon: "lock", title: "Admins only", note: "System memory is for a forge admin who is a person.", action: btn("Go home", { href: "/", variant: "primary" }) })}`,
    },
    403,
  );

export async function systemPage(ctx: Ctx): Promise<Response> {
  if (!canSeeMemory(ctx.auth.user)) return forbiddenPage(ctx);
  const hours = memoryHours(ctx.app.db, Date.now());
  const series = (title: string, pick: (h: (typeof hours)[number]) => number) =>
    card(
      html`<div class="chart-box">${raw(drawChart("line", hours.map((h) => ({ label: hhmm(h.at).slice(11), value: pick(h) / 1_048_576 })), title))}</div>`,
      { head: html`<h2>${title}</h2>` },
    );
  const body =
    hours.length === 0
      ? empty({ icon: "activity", title: "No samples yet", note: "The forge samples its memory every minute; the first hour appears shortly." })
      : html`<div class="sys-pair">${series("RSS (MiB, hourly mean)", (h) => h.rssMean)}${series("JS heap (MiB, hourly mean)", (h) => h.heapMean)}</div>
        <table class="table">
          <thead><tr><th scope="col">Hour (UTC)</th><th scope="col" class="num">RSS mean</th><th scope="col" class="num">RSS max</th><th scope="col" class="num">Heap mean</th><th scope="col" class="num">Heap max</th></tr></thead>
          <tbody>${hours.map((h) => html`<tr><td class="mono">${hhmm(h.at)}</td><td class="num mono">${mib(h.rssMean)}</td><td class="num mono">${mib(h.rssMax)}</td><td class="num mono">${mib(h.heapMean)}</td><td class="num mono">${mib(h.heapMax)}</td></tr>`)}</tbody>
        </table>`;
  return page({
    ctx,
    title: "System",
    body: html`<div class="page-head"><h1>System memory</h1></div>${body}`,
  });
}
