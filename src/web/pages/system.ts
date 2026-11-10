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
 * Between them, the main-thread stalls of the last hour by route (#9016),
 * read once at first paint from the loop watch: the top routes plus
 * /api/v1/telemetry/flow always, as /metrics exports them.
 * Then the in-process caches that answer strangers' code pages (#9514), each
 * with its entries, bytes held beside its cap, and hits and misses: together
 * they may hold ~128 MB, so what they hold is shown where memory is.
 */
import { canSeeMemory, memoryHours } from "../../boards/memory.ts";
import { telemetryReader } from "../../actions/telemetry.ts";
import type { Ctx } from "../../http/context.ts";
import { memoryCapHolder } from "../../apps/contain.ts";
import { bytes, spark, span } from "../../system/format.ts";
import { eventStream } from "../../http/sse.ts";
import type { SystemView } from "../../system/view.ts";
import { live } from "../../system/live.ts";
import { readerPaces, type ReaderPace } from "../../system/telemetry_reads.ts";
import { stallHour } from "../../metrics/stalls.ts";
import type { RouteStall } from "../../perf/loop.ts";
import { loopWatch } from "../../perf/live.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { html, raw, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { systemLiveJs } from "../system-live.ts";
import { RECENT_BYTES, recentEncodings } from "../../http/compress.ts";
import { KEPT_PAGE_BYTES, keptPageStats } from "./kept_page.ts";
import { COLUMN_BYTES, PARTS_BYTES, keptPartsStats, treeCacheStats } from "./tree_cache.ts";
import { featureHealth, type FeatureHealth } from "../../system/feature_health.ts";
import { badge, chartBox, meter, pill, row } from "../ui.ts";

/** A group's memory, and a cell's beside its cap and who holds the cap. */
const memoryOf = (g: { rssBytes: number; capBytes: number | null; capBy: "kernel" | "watch" | null }): Html =>
  g.capBytes === null
    ? html`${bytes(g.rssBytes)}`
    : html`${bytes(g.rssBytes)} <span class="muted small" data-cap="${String(g.capBytes)}" data-cap-by="${g.capBy ?? ""}">of ${bytes(g.capBytes)} (${g.capBy === "kernel" ? "kernel cap" : "watched"})</span>`;

const pct = (n: number | null): string => (n === null ? "—" : `${n.toFixed(1)}%`);
const coresOf = (n: number | null): string => (n === null ? "—" : n.toFixed(2));

const rateOf = (n: number | null): string => (n === null ? "—" : `${bytes(n)}/s`);

/** One line of the machine card: a name, a meter, its figure and (for a core) its history. */
const meterRow = (name: string, value: number | null, max: number, figure: string, history = ""): Html => {
  const share = max > 0 ? ((value ?? 0) / max) * 100 : 0;
  return row({
    title: name,
    titleAttr: name,
    meta: html`${meter(share, `${name} ${figure}`, share >= 85 ? "attn" : undefined)}${history ? html` <span class="mono" aria-hidden="true">${history}</span>` : null}`,
    trail: html`<span class="mono">${figure}</span>`,
  });
};

/** A name and one figure, no bar: load, a disk's I/O, a link's rates. */
const figureRow = (name: string, figure: string, data: Record<string, string> = {}): Html =>
  row({ title: name, trail: html`<span class="mono">${figure}</span>`, data });

/** Processes grouped forge, crew, check, app, host; the client re-sorts them by CPU or memory (`system-live.ts`). */
const KIND_ORDER = ["forge", "crew", "check", "app", "host"] as const;
function procTable(v: SystemView): Html {
  const groups = KIND_ORDER.flatMap((k) => v.groups.filter((g) => g.kind === k));
  if (groups.length === 0) return html`<p class="muted">No processes were read.</p>`;
  return html`<div class="table-scroll"><table class="table" data-dense aria-label="Processes by what launched them">
    <thead><tr><th scope="col">pid</th><th scope="col">command</th><th scope="col" class="num">cpu</th><th scope="col" class="num">mem</th><th scope="col" class="num">age</th></tr></thead>
    ${groups.map(
      (g) => html`<tbody data-kind="${g.kind}" data-cpu="${String(g.cpuCores ?? 0)}" data-mem="${String(g.rssBytes)}">
        <tr data-group><th scope="colgroup" colspan="2"><strong>${g.label}</strong> ${badge(`${String(g.procs)} procs`, { variant: "secondary" })}</th>
          <td class="num">${coresOf(g.cpuCores)}</td><td class="num">${memoryOf(g)}</td><td class="num">${span(g.oldestSeconds)}</td></tr>
        ${g.top.map(
          (p) => html`<tr data-cpu="${String(p.cpuCores ?? 0)}" data-mem="${String(p.rssBytes)}"><td class="mono">${String(p.pid)}</td><td class="mono">${p.comm}</td>
            <td class="num mono">${coresOf(p.cpuCores)}</td><td class="num mono">${bytes(p.rssBytes)}</td><td class="num mono">${span(p.ageSeconds)}</td></tr>`,
        )}
      </tbody>`,
    )}
  </table></div>`;
}

const mib = (n: number) => `${(n / 1_048_576).toFixed(1)} MiB`;
const hhmm = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");

/** The forge's RSS beside its JS heap, an hour a row; empty for anyone `canSeeMemory` refuses. */
function memorySection(ctx: Ctx): Html {
  if (!canSeeMemory(ctx.auth.user)) return html``;
  const hours = timePhase(ctx.request, "memory", () => memoryHours(ctx.app.db, Date.now()));
  const series = (title: string, pick: (h: (typeof hours)[number]) => number) =>
    html`<div><h3 class="small">${title}</h3>${chartBox("line", hours.map((h) => ({ label: hhmm(h.at).slice(11), value: pick(h) / 1_048_576 })), title)}</div>`;
  return html`<section class="settings-block" id="sys-memory"><h2>Forge memory</h2>${hours.length === 0
    ? html`<p class="muted">No samples yet: the forge samples its memory every minute, so the first hour appears shortly.</p>`
    : html`<div class="plots">${series("RSS (MiB, hourly mean)", (h) => h.rssMean)}${series("JS heap (MiB, hourly mean)", (h) => h.heapMean)}</div>
        <div class="table-scroll"><table class="table" aria-label="Forge memory by hour">
          <thead><tr><th scope="col">Hour (UTC)</th><th scope="col" class="num">RSS mean</th><th scope="col" class="num">RSS max</th><th scope="col" class="num">Heap mean</th><th scope="col" class="num">Heap max</th></tr></thead>
          <tbody>${hours.map((h) => html`<tr><td class="mono">${hhmm(h.at)}</td><td class="num mono">${mib(h.rssMean)}</td><td class="num mono">${mib(h.rssMax)}</td><td class="num mono">${mib(h.heapMean)}</td><td class="num mono">${mib(h.heapMax)}</td></tr>`)}</tbody>
        </table></div>`}</section>`;
}

/** One in-process cache as it stands: what it is for, its byte cap, and `ViewCache.stats()`. */
export interface CacheRow {
  readonly name: string;
  readonly holds: string;
  readonly capBytes: number;
  readonly entries: number;
  readonly bytes: number;
  readonly hits: number;
  readonly misses: number;
}

/** The caches behind strangers' code pages, now, each beside its own byte cap. */
export const pageCaches = (): CacheRow[] => [
  { name: "kept pages", holds: "a stranger's finished pinned page, encoded (kept_page.ts)", capBytes: KEPT_PAGE_BYTES, ...keptPageStats() },
  { name: "encoded bodies", holds: "identity-free bodies, brotli or gzip (compress.ts)", capBytes: RECENT_BYTES, ...recentEncodings() },
  { name: "page columns", holds: "rendered tree and blob columns (tree_cache.ts)", capBytes: COLUMN_BYTES, ...treeCacheStats() },
  { name: "folders and refs", holds: "folder listings at a commit, ref names (tree_cache.ts)", capBytes: PARTS_BYTES, ...keptPartsStats() },
];

/** `pageCaches`' rows as a table; the hit rate is hits over hits and misses since the process started. */
export function cachesSection(rows: readonly CacheRow[]): Html {
  const rate = (r: CacheRow) => (r.hits + r.misses === 0 ? "—" : `${((100 * r.hits) / (r.hits + r.misses)).toFixed(1)}%`);
  return html`<section class="settings-block"><h2>Code page caches</h2>
    <p class="small muted">Counts since this process started.</p>
      <div class="table-scroll"><table class="table" aria-label="Code page caches">
        <thead><tr><th scope="col">Cache</th><th scope="col">Holds</th><th scope="col" class="num">Entries</th><th scope="col" class="num">Bytes</th><th scope="col" class="num">Cap</th><th scope="col" class="num">Hits</th><th scope="col" class="num">Misses</th><th scope="col" class="num">Hit rate</th></tr></thead>
        <tbody>${rows.map((r) => html`<tr data-cache="${r.name}" data-bytes="${String(r.bytes)}"><td>${r.name}</td><td class="small muted">${r.holds}</td><td class="num mono">${String(r.entries)}</td><td class="num mono">${mib(r.bytes)}</td><td class="num mono">${mib(r.capBytes)}</td><td class="num mono">${String(r.hits)}</td><td class="num mono">${String(r.misses)}</td><td class="num mono">${rate(r)}</td></tr>`)}</tbody>
      </table></div></section>`;
}

/** Absorbed apps and whether production is serving (#9887); `featureHealth`'s rows. Nothing absorbed, nothing drawn. */
export function featuresSection(rows: readonly FeatureHealth[]): Html {
  if (rows.length === 0) return html``;
  return html`<section class="settings-block" id="sys-features"><h2>Features from apps</h2>
    <ul class="list" aria-label="Absorbed features and their health">${rows.map((r) =>
      row({
        href: `/${r.repo}`,
        nav: true,
        title: r.name,
        meta: html`${r.healthy ? html`<span class="small muted">${r.state}</span>` : badge(r.state, { tone: "danger" })}
          <span class="small muted mono">${[r.commit, r.since].filter((x) => x !== null).join(" · ")}</span>${r.problem === null ? null : html` <span class="small muted">${r.problem}</span>`}`,
        data: { feature: r.slug, healthy: String(r.healthy) },
      }),
    )}</ul>
    <p class="small"><a href="/settings/features">Settings › Features</a></p></section>`;
}

/** The last hour's stalls by route, most milliseconds first; the rows are `stallHour`'s. */
export function stallSection(rows: readonly RouteStall[]): Html {
  return html`<section class="settings-block"><h2>Main-thread stalls, last hour</h2>
    <p class="small muted">Past 250 ms, as of this page's load; <code>/metrics</code> has the series.</p>${
    rows.length === 0
      ? html`<p class="muted">No stalls in the last hour.</p>`
      : html`<div class="table-scroll"><table class="table" aria-label="Main-thread stalls by route, last hour">
        <thead><tr><th scope="col">Route</th><th scope="col" class="num">Stall ms</th><th scope="col" class="num">Stalls</th></tr></thead>
        <tbody>${rows.map((r) => html`<tr data-route="${r.route}"><td class="mono">${r.route}</td><td class="num mono">${String(Math.round(r.ms))}</td><td class="num mono">${String(r.count)}</td></tr>`)}</tbody>
      </table></div>`}</section>`;
}

/** Who read the telemetry routes in the last 10 minutes and how fast (#9069); `readerPaces`' rows. */
export function readersSection(rows: readonly ReaderPace[]): Html {
  const secs = (ms: number | null): string => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);
  return html`<section class="settings-block"><h2>Telemetry readers</h2>${
    rows.length === 0
      ? html`<p class="muted">No telemetry reads in the last 10 minutes.</p>`
      : html`<div class="table-scroll"><table class="table" aria-label="Telemetry readers, last 10 minutes">
          <thead><tr><th scope="col">Route</th><th scope="col">Reader</th><th scope="col" class="num">Reads, 10 min</th><th scope="col" class="num">Mean interval</th><th scope="col"></th></tr></thead>
          <tbody>${rows.map((r) => html`<tr data-route="${r.route}" data-reader="${r.reader}"><td class="mono">${r.route}</td><td class="mono">${r.reader}</td><td class="num mono">${String(r.reads)}</td><td class="num mono">${secs(r.meanIntervalMs)}</td><td>${r.tooFast ? badge("faster than the flow copy changes", { tone: "danger" }) : null}</td></tr>`)}</tbody>
        </table></div>`}</section>`;
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
  const out: Record<string, Html> = {
    "sys-dup": dup,
    summary: html`${pill(`CPU ${pct(v.cpu.busyPct)}`, v.cpu.busyPct !== null && v.cpu.busyPct >= 90 ? "danger" : undefined)}
          ${pill(`${String(v.cpu.cores.length)} cores`)}
          ${pill(`load ${v.load ? v.load.map((l) => l.toFixed(2)).join(" ") : "—"}`)}
          ${pill(`hottest ${v.hottestC === null ? "—" : `${v.hottestC.toFixed(0)}°C`}`)}
          ${pill(`memory ${v.memory ? `${bytes(v.memory.usedBytes)} of ${bytes(v.memory.totalBytes)}` : "—"}`)}
          ${pill(`${String(v.processes)} processes`)}`,
    cores: html`${v.cpu.cores.map((c, i) => meterRow(`cpu${String(i)}`, c, 100, c === null ? "—" : `${c.toFixed(0)}%`, spark(v.cpu.history[i] ?? [])))}`,
    mem: html`${v.memory
        ? html`${meterRow("mem", v.memory.usedBytes, v.memory.totalBytes, `${bytes(v.memory.usedBytes)} / ${bytes(v.memory.totalBytes)}`)}
            ${meterRow("swap", v.memory.swapUsedBytes, v.memory.swapTotalBytes, v.memory.swapTotalBytes === 0 ? "none" : `${bytes(v.memory.swapUsedBytes)} / ${bytes(v.memory.swapTotalBytes)}`)}`
        : null}
      ${v.load ? figureRow("load", v.load.map((l) => l.toFixed(2)).join("  ")) : null}`,
    temps: html`${v.temps.map((t) => `${t.chip} ${t.label} ${t.celsius.toFixed(0)}°C`).join(" · ")}`,
    "sys-disks":
      v.disks.length + v.io.length + v.net.length === 0
        ? html`<li class="muted">No disks or network were read.</li>`
        : html`${v.disks.map((d) => meterRow(d.mount, d.usedBytes, d.totalBytes, `${bytes(d.usedBytes)} / ${bytes(d.totalBytes)} ${d.fs}`))}
        ${v.io.map((d) => figureRow(d.name, `R ${rateOf(d.readBytesPerSecond)} W ${rateOf(d.writeBytesPerSecond)}`, { io: d.name }))}
        ${v.net.map((n) => figureRow(n.name, `↓ ${rateOf(n.rxBytesPerSecond)} ↑ ${rateOf(n.txBytesPerSecond)}`, { net: n.name }))}`,
    "sys-procs": procTable(v),
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
  return eventStream(ctx.app, ctx.request, (emit, _close, ready) => {
    emit("sample", sampleFrame(sampler.read()));
    return sampler.subscribe((view) => {
      if (ready()) emit("sample", sampleFrame(view));
    });
  });
}

// GET /system
export function systemPage(ctx: Ctx): Response {
  if (!ctx.auth.user) return signInFirst(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const reader = timePhase(ctx.request, "reader", () => telemetryReader(ctx.app, ctx.auth.user!));
  if (reader?.kind !== "owner") return notFoundPage(ctx);
  const v = timePhase(ctx.request, "sample", () => live().read());
  const holder = timePhase(ctx.request, "caps", () => memoryCapHolder());
  const caps: Html =
    holder.by === "kernel"
      ? html`<p class="small" id="cell-caps" data-by="kernel">Each cell's memory is capped by the kernel (its own cgroup's <code>memory.max</code>): a cell over it is killed alone.</p>`
      : html`<p class="small" id="cell-caps" data-by="watch">Each cell's memory is watched once a second and the cell stopped over its cap; the kernel does not cap it (${holder.reason}).</p>`;
  const memory = memorySection(ctx);
  const stalls = timePhase(ctx.request, "stalls", () => stallHour(loopWatch.tally(performance.now())));
  const rendering = performance.now();
  const r = regions(v);
  const at = (id: string): Html => raw(r[id]!);
  const body = html`<div class="page-head">
      <h1>System</h1>
      <p class="muted">
        The machine now, updated in place about every 2 s over one event
        stream; <a href="/system?pause">pause</a>. Its history is on
        <a href="/boards">Boards</a> (the machine source); the pipeline is on
        <a href="/boards">Boards</a>.
      </p>
    </div>
    <div id="sys-dup">${at("sys-dup")}</div>
    <section class="settings-block"><h2>Machine</h2>
      <div id="summary" class="row-meta">${at("summary")}</div>
        <ul class="list" id="cores" aria-label="Per-core CPU, percent, with its last readings">${at("cores")}</ul>
        <ul class="list" id="mem">${at("mem")}</ul>
        ${caps}
        <p class="small mono" id="temps">${at("temps")}</p></section>
    <section class="settings-block"><h2>Disks and network</h2>
      <ul class="list" id="sys-disks">${at("sys-disks")}</ul></section>
    <section class="settings-block"><h2>Processes</h2>
      <div class="js-only small muted">Sort by <button class="btn" data-size="sm" type="button" data-sort="cpu" aria-pressed="true"><kbd>c</kbd> CPU</button>
        <button class="btn" data-size="sm" type="button" data-sort="mem" aria-pressed="false"><kbd>m</kbd> memory</button></div>
      <div id="sys-procs">${at("sys-procs")}</div></section>
    ${featuresSection(timePhase(ctx.request, "features", () => featureHealth(ctx.app, reader)))}
    <div id="sys-stalls">${stallSection(stalls)}</div>
    <div id="sys-readers">${readersSection(readerPaces())}</div>
    <div id="sys-caches">${cachesSection(pageCaches())}</div>
    ${memory}`;
  const response = page({ ctx, title: "System", body, wide: true, scriptJs: systemLiveJs });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
