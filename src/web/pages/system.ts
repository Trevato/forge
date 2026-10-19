/**
 * /system, for the owner: the machine as it is now — cores, temperatures,
 * load, memory, disks, network — and every process grouped by what the
 * forge launched it for, each with CPU, memory and age. The same test file
 * in more than one check at once is named at the top. It updates in place
 * over one event stream (`/system/stream`, `system-live.ts` patches it; `?pause`
 * leaves it still) and never reloads or polls; while someone watches, the
 * sampler (`system/live.ts`) pushes a reading every 2 s. Numbers are `system/view.ts`'s.
 * Below it, for a forge admin who is a person, the forge's resident memory
 * (RSS) beside its JS heap, hourly for 24 h (#2151): RSS climbing while the
 * heap stays flat is native memory growth. Drawn on the server as SVG.
 */
import { drawChart } from "../../boards/chart.ts";
import { canSeeMemory, memoryHours } from "../../boards/memory.ts";
import { telemetryReader } from "../../actions/telemetry.ts";
import type { Ctx } from "../../http/context.ts";
import { memoryCapHolder } from "../../apps/contain.ts";
import { bytes, span } from "../../system/format.ts";
import { eventStream } from "../../http/sse.ts";
import type { SystemView } from "../../system/view.ts";
import { live } from "../../system/live.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { html, raw, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { systemLiveJs } from "../system-live.ts";
import { card, empty, listCard, pill, row } from "../ui.ts";

/** A group's memory, and a cell's beside its cap and who holds the cap. */
const memoryOf = (g: { rssBytes: number; capBytes: number | null; capBy: "kernel" | "watch" | null }): Html =>
  g.capBytes === null
    ? html`${bytes(g.rssBytes)}`
    : html`${bytes(g.rssBytes)} <span class="muted small" data-cap="${String(g.capBytes)}" data-cap-by="${g.capBy ?? ""}">of ${bytes(g.capBytes)} (${g.capBy === "kernel" ? "kernel cap" : "watched"})</span>`;

const pct = (n: number | null): string => (n === null ? "—" : `${n.toFixed(1)}%`);
const coresOf = (n: number | null): string => (n === null ? "—" : n.toFixed(2));

const mib = (n: number) => `${(n / 1_048_576).toFixed(1)} MiB`;
const hhmm = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");

/** The forge's RSS beside its JS heap, an hour a row; empty for anyone `canSeeMemory` refuses. */
function memorySection(ctx: Ctx): Html {
  if (!canSeeMemory(ctx.auth.user)) return html``;
  const hours = memoryHours(ctx.app.db, Date.now());
  const series = (title: string, pick: (h: (typeof hours)[number]) => number) =>
    card(
      html`<div class="chart-box">${raw(drawChart("line", hours.map((h) => ({ label: hhmm(h.at).slice(11), value: pick(h) / 1_048_576 })), title))}</div>`,
      { head: html`<h2>${title}</h2>` },
    );
  return hours.length === 0
    ? empty({ icon: "activity", title: "No samples yet", note: "The forge samples its memory every minute; the first hour appears shortly." })
    : html`<div class="sys-pair">${series("RSS (MiB, hourly mean)", (h) => h.rssMean)}${series("JS heap (MiB, hourly mean)", (h) => h.heapMean)}</div>
        <table class="table" aria-label="Forge memory by hour">
          <thead><tr><th scope="col">Hour (UTC)</th><th scope="col" class="num">RSS mean</th><th scope="col" class="num">RSS max</th><th scope="col" class="num">Heap mean</th><th scope="col" class="num">Heap max</th></tr></thead>
          <tbody>${hours.map((h) => html`<tr><td class="mono">${hhmm(h.at)}</td><td class="num mono">${mib(h.rssMean)}</td><td class="num mono">${mib(h.rssMax)}</td><td class="num mono">${mib(h.heapMean)}</td><td class="num mono">${mib(h.heapMax)}</td></tr>`)}</tbody>
        </table>`;
}

/**
 * The parts of the page a sample moves, each the inner markup of the element
 * of that id. The first paint and every pushed sample are drawn by this one
 * function, so the stream can only ever say what the page would have.
 */
export function regions(v: SystemView): Record<string, string> {
  const dup: Html =
    v.duplicates.length === 0
      ? html`<p id="duplicates" data-count="0" class="muted">No test file is running in more than one check.</p>`
      : html`<p id="duplicates" data-count="${String(v.duplicates.length)}">
            <strong>${String(v.duplicates.length)} test file${v.duplicates.length === 1 ? " is" : "s are"}
            running in more than one check at once:</strong>
          </p>
          <ul class="list small mono">
            ${v.duplicates.map((d) => html`<li>${d.file} · ${String(d.checks.length)} checks: ${d.checks.join(", ")}</li>`)}
          </ul>`;
  const cores = v.cpu.cores.map(
    (c, i) => html`<span class="mono small" title="cpu${String(i)}">${c === null ? "—" : String(Math.round(c))}</span> `,
  );
  const out: Record<string, Html> = {
    "sys-dup": dup,
    summary: html`${pill(`CPU ${pct(v.cpu.busyPct)}`, v.cpu.busyPct !== null && v.cpu.busyPct >= 90 ? "danger" : undefined)}
          ${pill(`${String(v.cpu.cores.length)} cores`)}
          ${pill(`load ${v.load ? v.load.map((l) => l.toFixed(2)).join(" ") : "—"}`)}
          ${pill(`hottest ${v.hottestC === null ? "—" : `${v.hottestC.toFixed(0)}°C`}`)}
          ${pill(`memory ${v.memory ? `${bytes(v.memory.usedBytes)} of ${bytes(v.memory.totalBytes)}` : "—"}`)}
          ${pill(`${String(v.processes)} processes`)}`,
    cores: html`${cores}`,
    temps: html`${v.temps.map((t) => `${t.chip} ${t.label} ${t.celsius.toFixed(0)}°C`).join(" · ")}`,
    "sys-disks": listCard(
      [
        ...v.disks.map((d) =>
          row({
            title: html`<span class="mono">${d.mount}</span>`,
            meta: html`${d.fs}`,
            trail: html`${pill(`${String(Math.round((d.usedBytes / d.totalBytes) * 100))}%`)} ${bytes(d.totalBytes)}`,
          }),
        ),
        ...v.net.map((n) =>
          row({
            title: html`<span class="mono">${n.name}</span>`,
            trail: html`↓ ${n.rxBytesPerSecond === null ? "—" : `${bytes(n.rxBytesPerSecond)}/s`} ↑ ${n.txBytesPerSecond === null ? "—" : `${bytes(n.txBytesPerSecond)}/s`}`,
          }),
        ),
      ],
      { head: html`<h2>Disks and network</h2>` },
    ),
    "sys-procs": listCard(
      v.groups.map(
        (g) => html`<li data-kind="${g.kind}"><div class="row">
          <span class="row-main"><span class="row-title mono">${g.label}</span>
            <span class="row-meta">${String(g.procs)} processes · oldest ${span(g.oldestSeconds)}${g.top.length ? html` · ${g.top.slice(0, 3).map((p) => `${p.comm} ${coresOf(p.cpuCores)}`).join(" · ")}` : null}</span></span>
          <span class="row-trail">${pill(`${coresOf(g.cpuCores)} cores`)} ${memoryOf(g)}</span>
        </div></li>`,
      ),
      { head: html`<h2>Processes</h2>` },
    ),
  };
  return Object.fromEntries(Object.entries(out).map(([k, h]) => [k, h.text]));
}

/** The sample as the stream sends it. */
export const sampleFrame = (v: SystemView): { regions: Record<string, string> } => ({ regions: regions(v) });

// GET /system/stream: the owner's live samples, one frame each.
export function systemStream(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  if (telemetryReader(ctx.app, ctx.auth.user)?.kind !== "owner") return notFoundPage(ctx);
  const sampler = live();
  return eventStream(ctx.request, (emit, _close, ready) => {
    emit("sample", sampleFrame(sampler.read()));
    return sampler.subscribe((view) => {
      if (ready()) emit("sample", sampleFrame(view));
    });
  });
}

// GET /system
export function systemPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  const reader = telemetryReader(ctx.app, ctx.auth.user);
  if (reader?.kind !== "owner") return notFoundPage(ctx);
  const v = live().read();
  const holder = memoryCapHolder();
  const caps: Html =
    holder.by === "kernel"
      ? html`<p class="small" id="cell-caps" data-by="kernel">Each cell's memory is capped by the kernel (its own cgroup's <code>memory.max</code>): a cell over it is killed alone.</p>`
      : html`<p class="small" id="cell-caps" data-by="watch">Each cell's memory is watched once a second and the cell stopped over its cap; the kernel does not cap it (${holder.reason}).</p>`;
  const r = regions(v);
  const at = (id: string): Html => raw(r[id]!);
  const body = html`<div class="page-head">
      <h1>System</h1>
      <p class="muted">
        The machine now, updated in place about every 2 s over one event
        stream; <a href="/system?pause">pause</a>. Its history is on
        <a href="/boards">Boards</a> (the machine source); the pipeline is on
        <a href="/flow">Flow</a>.
      </p>
    </div>
    <div id="sys-dup">${at("sys-dup")}</div>
    ${card(
      html`<div id="summary" class="row-meta">${at("summary")}</div>
        <p class="small" id="cores" aria-label="Per-core CPU, percent">${at("cores")}</p>
        ${caps}
        <p class="small mono" id="temps">${at("temps")}</p>`,
      { head: html`<h2>Machine</h2>` },
    )}
    <div id="sys-disks">${at("sys-disks")}</div>
    <div id="sys-procs">${at("sys-procs")}</div>
    ${memorySection(ctx)}`;
  return page({ ctx, title: "System", body, wide: true, scriptJs: systemLiveJs });
}
