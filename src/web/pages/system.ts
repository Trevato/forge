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
 * Just above the stalls, the last 20 minutes' worst loop lag against the
 * 100 ms bar (#11220, `perf/lag_minutes.ts`), each minute over it named.
 * Then the in-process caches that answer strangers' code pages (#9514), each
 * with its entries, bytes held beside its cap, and hits and misses: together
 * they may hold ~128 MB, so what they hold is shown where memory is.
 * A child forge in a cell shows its own size and its use against it, one
 * line each for memory, CPU and disk; a parent lists each child's use
 * against its size (#10853, `spawn/usage.ts`).
 */
import { mayReadRefusals } from "../../core/first_ask_refusals.ts";
import { canSeeMemory, memoryHours } from "../../boards/memory.ts";
import { telemetryReader } from "../../actions/telemetry.ts";
import type { Ctx } from "../../http/context.ts";
import { memoryCapHolder, PROCESSES_MAX, processCapHolder } from "../../apps/contain.ts";
import { bytes, spark, span } from "../../system/format.ts";
import { eventStream } from "../../http/sse.ts";
import type { SystemView } from "../../system/view.ts";
import { live } from "../../system/live.ts";
import { readerPaces, type ReaderPace } from "../../system/telemetry_reads.ts";
import { slowPageLine, slowPages, type SlowPage } from "../../perf/watch.ts";
import { stallHour } from "../../metrics/stalls.ts";
import { HOUR_MS, type RouteStall } from "../../perf/loop.ts";
import { lagMinutes, loopWatch, stallBlame } from "../../perf/live.ts";
import { LAG_BAR_MS, LAG_READINGS, overBar, type LagReading } from "../../perf/lag_minutes.ts";
import { WORST_STALLS, type BlamedStall } from "../../perf/stall_blame.ts";
import { notePhase, takeSessionTime, timePhase } from "../../core/route_timing.ts";
import { notFoundPage, signInFirst } from "../chrome.ts";
import { html, raw, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { systemLiveJs } from "../system-live.ts";
import { RECENT_BYTES, recentEncodings } from "../../http/compress.ts";
import { KEPT_PAGE_BYTES, keptPageStats } from "./kept_page.ts";
import { COLUMN_BYTES, PARTS_BYTES, keptPartsStats, treeCacheStats } from "./tree_cache.ts";
import { featureHealth, type FeatureHealth } from "../../system/feature_health.ts";
import { egressReportedLine } from "../../system/egress_line.ts";
import { BREAK_STEPS, MACHINES, declaredFooting, footing, offMachine, whereWords, type Footing, type Machine } from "../../system/footing.ts";
import { badge, chartBox, disclosure, meter, pill, row, time } from "../ui.ts";
import { childDirOf, listChildren } from "../../actions/spawn.ts";
import { childrenUse, realSelf, selfUse, shareOf, sizeWords, useWords, type ChildUseRow, type SelfUse } from "../../spawn/usage.ts";

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

/** This forge's own size and use when it is a child in a cell (#10853); nothing on any other forge. */
export function selfSection(self: SelfUse | null): Html {
  if (self === null) return html``;
  const { use, size } = self;
  const w = useWords(use);
  return html`<section class="settings-block" id="sys-self" data-size="${size}" data-from="${self.from}"><h2>This forge's size: ${size}</h2>
    <ul class="list" aria-label="This forge's use against its size">
      ${meterRow("memory", use.memoryMiB, use.limits.memoryMiB, w.memory)}
      ${meterRow("cpu", use.cores, use.limits.cpu, use.cores === null ? `measuring · ${w.cpu}` : w.cpu)}
      ${meterRow("disk", use.diskMiB, use.limits.diskMiB, w.disk)}
    </ul>
    </section>`;
}

/** What this forge's own size section leaves to the page's `?`: who set the size and what is measured. */
export const selfHelp = (self: SelfUse | null): Html | null =>
  self === null ? null : html`<p id="sys-self-help">Size is set by the forge that made this one. ${self.from === "process" ? "Memory and CPU count this process alone. " : ""}Disk is measured every 30 seconds.</p>`;

/** What a child row says beside its meter: a cell's three figures, or why there are none. */
const childSaid = (r: ChildUseRow): string => {
  if (r.use.kind === "shared") return "shared with this forge";
  if (r.use.kind === "idle") return "not running";
  const w = useWords(r.use);
  return `memory ${w.memory} · cpu ${w.cpu} · disk ${w.disk}`;
};

/** Each child this forge made, its use against its size (#10853); nothing when it made none. */
export function childrenSection(rows: readonly ChildUseRow[]): Html {
  if (rows.length === 0) return html``;
  return html`<section class="settings-block" id="sys-children"><h2>Child forges</h2>
    <ul class="list" aria-label="Each child forge's use against its size">${rows.map((r) => {
      const said = childSaid(r);
      const share = r.use.kind === "cell" ? shareOf(r.use.memoryMiB, r.use.limits.memoryMiB) : null;
      return row({
        title: /^https?:\/\//.test(r.url) ? html`<a href="${r.url}">${r.name}</a>` : r.name,
        titleAttr: r.name,
        meta: html`${share === null ? null : html`${meter(share, `${r.name} memory`, share >= 85 ? "attn" : undefined)} `}<span class="mono small">${said}</span>`,
        trail: html`<span class="mono small">${sizeWords(r.size)}</span>`,
        data: { child: r.name, use: r.use.kind },
      });
    })}</ul></section>`;
}

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
    ? html`<p class="muted">No samples yet.</p>`
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
  return html`<section class="settings-block"><h2>Code page caches, since start</h2>
      <div class="table-scroll"><table class="table" aria-label="Code page caches">
        <thead><tr><th scope="col">Cache</th><th scope="col" class="num">Entries</th><th scope="col" class="num">Bytes</th><th scope="col" class="num">Cap</th><th scope="col" class="num">Hits</th><th scope="col" class="num">Misses</th><th scope="col" class="num">Hit rate</th></tr></thead>
        <tbody>${rows.map((r) => html`<tr data-cache="${r.name}" data-bytes="${String(r.bytes)}"><td>${r.name}</td><td class="num mono">${String(r.entries)}</td><td class="num mono">${mib(r.bytes)}</td><td class="num mono">${mib(r.capBytes)}</td><td class="num mono">${String(r.hits)}</td><td class="num mono">${String(r.misses)}</td><td class="num mono">${rate(r)}</td></tr>`)}</tbody>
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

/**
 * What the forge stands on (#11685): each piece it needs to answer, sign in,
 * build, release and back up, and where it was found. The summary gives the
 * one count; inside, each piece on another machine, in the order switching
 * pg-grand off would break the forge, one fact a line; then the pieces on the
 * forge's own machine, by name. `system/footing.ts`'s rows.
 */
export function footingSection(f: Footing): Html {
  const off = offMachine(f);
  const home = f.rows.filter((r) => !r.risk);
  // First sight (#11111): the heading and one count stay; the rows open behind one disclosure.
  const count = off.length === 0 ? "Every piece runs on the forge's own machine" : `${off.length} of ${f.rows.length} pieces run on another machine`;
  return html`<section class="settings-block" id="sys-footing" data-off="${String(off.length)}" data-forge-node="${f.forgeNode ?? ""}"><h2>What the forge stands on</h2>
    ${disclosure(count, html`<p class="small">${f.forgeNode === null ? html`The forge's node was not read (${f.unread ?? "unknown"}), so each piece shows the machine written in <code>docs/OPERATING.md</code>.` : html`The forge runs on <span class="mono">${f.forgeNode}</span>.`}
      ${off.length === 0 ? null : "If that machine stops, each piece below stops with it; they are listed in the order the forge would lose them."}</p>
    ${off.length === 0 ? null : html`<ul class="list" aria-label="Pieces on another machine">${off.map((r) =>
      row({
        title: r.what,
        facts: [
          { label: "Needed to", value: r.need },
          { label: "Runs on", value: html`<span class="mono">${whereWords(r)}</span>` },
          { label: "If it stops", value: r.ifDies },
          ...(r.breaks ? [{ label: "Order", value: `${r.breaks} of ${BREAK_STEPS.length}: ${BREAK_STEPS[r.breaks - 1]}` }] : []),
          ...(r.issues.length ? [{ label: "Fixed by", value: r.issues.map((n) => `#${n}`).join(", ") }] : []),
        ],
        data: { piece: r.id, off: "true", seen: r.seen.by, ...(r.breaks ? { breaks: String(r.breaks) } : {}) },
      }),
    )}</ul>`}
    ${home.length === 0 ? null : html`<p class="small muted">On the forge's own machine: ${home.map((r, i) => html`${i ? ", " : ""}<span data-piece="${r.id}" data-off="false">${r.what}</span>`)}.</p>`}
    ${(Object.keys(MACHINES) as Machine[]).map((m) => html`<p class="small muted" data-machine="${m}"><span class="mono">${m}</span>: ${MACHINES[m]}</p>`)}`, { id: "sys-footing-more" })}</section>`;
}

/** The last hour's stalls by route, most milliseconds first; the rows are `stallHour`'s. */
export function stallSection(rows: readonly RouteStall[], worst: Html = html``): Html {
  return html`<section class="settings-block"><h2>Main-thread stalls, last hour</h2>${
    rows.length === 0
      ? html`<p class="muted">No stalls in the last hour.</p>`
      : html`<div class="table-scroll"><table class="table" aria-label="Main-thread stalls by route, last hour">
        <thead><tr><th scope="col">Route</th><th scope="col" class="num">Stall ms</th><th scope="col" class="num">Stalls</th></tr></thead>
        <tbody>${rows.map((r) => html`<tr data-route="${r.route}"><td class="mono">${r.route}</td><td class="num mono">${String(Math.round(r.ms))}</td><td class="num mono">${String(r.count)}</td></tr>`)}</tbody>
      </table></div>`}${worst}</section>`;
}

/** How many of the last hour's worst stalls the page lists (#11069); the terminal lists as many. */
export { WORST_STALLS };

/**
 * The last hour's worst single stalls, each with what ran (#11069), drawn inside
 * the stalls section and only when there is one, so a quiet /system reads as before.
 * `at` is on the watcher's clock (`performance.now`); `nowMono`/`nowWall` are one
 * instant on it and on the wall clock, so a stall's wall time is `nowWall − (nowMono − at)`.
 */
export function worstStallsTable(rows: readonly BlamedStall[], nowMono: number, nowWall: number): Html {
  if (rows.length === 0) return html``;
  return html`<h3 id="sys-worst-stalls">Worst single stalls</h3><div class="table-scroll"><table class="table" aria-label="Worst single stalls, last hour">
        <thead><tr><th scope="col">What ran</th><th scope="col" class="num">ms</th><th scope="col">When</th></tr></thead>
        <tbody>${rows.map((r) => html`<tr data-what="${r.what}"><td class="mono">${r.what}</td><td class="num mono">${String(Math.round(r.ms))}</td><td>${time(new Date(nowWall - (nowMono - r.at)).toISOString())}</td></tr>`)}</tbody>
      </table></div>`;
}

/**
 * The last 20 minutes' worst loop lag against the 100 ms bar (#11220): how many
 * are over it, then one row a minute, oldest first — its worst ms, and what its
 * worst named stall ran under (`loopWorstWhat`'s name), or "not named" when no
 * wake in it passed the 200 ms stall limit. A row over the bar is marked.
 */
export function lagSection(rows: readonly LagReading[]): Html {
  const over = overBar(rows);
  return html`<div id="sys-lag" data-readings="${String(rows.length)}" data-over="${String(over)}"><section class="settings-block"><h2>Loop lag, last ${String(LAG_READINGS)} minutes</h2>${
    rows.length === 0
      ? html`<p class="muted">No full minute measured yet.</p>`
      : html`<div class="row-meta">${over === 0 ? badge(`all ${String(rows.length)} under ${String(LAG_BAR_MS)} ms`) : badge(`${String(over)} of ${String(rows.length)} over ${String(LAG_BAR_MS)} ms`, { tone: "danger" })}</div>
        <div class="table-scroll"><table class="table" aria-label="Worst loop lag each minute against the ${String(LAG_BAR_MS)} ms bar">
          <thead><tr><th scope="col">Minute</th><th scope="col" class="num">Worst ms</th><th scope="col">What ran</th></tr></thead>
          <tbody>${rows.map((r) => {
            const isOver = r.ms > LAG_BAR_MS;
            return html`<tr data-lag-over="${isOver ? "1" : "0"}"><td>${time(new Date(r.at).toISOString())}</td><td class="num mono">${String(Math.round(r.ms))}${isOver ? html` ${badge("over", { tone: "danger" })}` : null}</td><td class="mono">${r.what ?? html`<span class="muted">not named</span>`}</td></tr>`;
          })}</tbody>
        </table></div>`
  }</section></div>`;
}

const SLOW_TTL_MS = 5000;
let slowKept: { db: object; at: number; rows: SlowPage[] } | undefined;
/** `slowPages`, kept a few seconds so a busy /system never repeats the query; changes show on reload. */
function slowPagesCached(db: Parameters<typeof slowPages>[0]): SlowPage[] {
  const now = Date.now();
  if (slowKept === undefined || slowKept.db !== db || now - slowKept.at > SLOW_TTL_MS)
    slowKept = { db, at: now, rows: slowPages(db, now) };
  return slowKept.rows;
}

/** Real visitors' pages over budget (#10536): one line each, and nothing at all when every page is fast. */
export function slowPagesSection(rows: readonly SlowPage[]): Html {
  if (rows.length === 0) return html``;
  return html`<section class="settings-block" id="slow-pages"><h2>Pages over budget, last hour</h2>
    <ul class="list" aria-label="Pages over their budget for real visitors">${rows.map((p) => html`<li data-route="${p.route}" data-phase="${p.phase}">${slowPageLine(p)}</li>`)}</ul></section>`;
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
      ? html`<p id="duplicates" data-count="0" class="muted">✓ no repeated tests</p>`
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
export async function systemPage(ctx: Ctx): Promise<Response> {
  if (!ctx.auth.user) return signInFirst(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const reader = timePhase(ctx.request, "reader", () => telemetryReader(ctx.app, ctx.auth.user!));
  if (reader?.kind !== "owner") return notFoundPage(ctx);
  const v = timePhase(ctx.request, "sample", () => live().read());
  const [holder, pids] = timePhase(ctx.request, "caps", () => [memoryCapHolder(), processCapHolder()] as const);
  const caps: Html =
    holder.by === "kernel"
      ? html`<p id="cell-caps" data-by="kernel">Each cell's memory is capped by the kernel (its own cgroup's <code>memory.max</code>): a cell over it is killed alone.</p>`
      : html`<p id="cell-caps" data-by="watch">Each cell's memory is watched once a second and the cell stopped over its cap; the kernel does not cap it (${holder.reason}).</p>`;
  const processCaps: Html =
    pids.by === "kernel"
      ? html`<p id="cell-pids" data-by="kernel">Each cell's processes are capped by the kernel at ${PROCESSES_MAX} (its cgroup's <code>pids.max</code>; not a crew run's): a fork past it fails inside that cell.</p>`
      : html`<p id="cell-pids" data-by="watch">Each cell's processes are counted once a second and the cell stopped past ${PROCESSES_MAX}; the kernel does not cap them (${pids.reason}).</p>`;
  // The two caps as a word each beside the machine's figures; the sentences are in the `?`.
  const capWords: Html = html`<div class="row-meta" id="cap-words">${pill(`cell memory: ${holder.by === "kernel" ? "kernel-capped" : "watched"}`)} ${pill(`cell processes: ${pids.by === "kernel" ? "kernel-capped" : "watched"}`)}</div>`;
  const egressSaid = egressReportedLine(ctx.app.db);
  const egressLine: Html | null =
    egressSaid === null ? null : html`<p class="small" id="egress-reported">${egressSaid} <a href="/settings/capacity">Capacity</a></p>`;
  const memory = memorySection(ctx);
  // Size and children are the owner's to see, as the terminal's System command is (`canSeeMemory`).
  const owner = canSeeMemory(ctx.auth.user);
  const self = owner ? timePhase(ctx.request, "self", () => selfUse(realSelf(ctx.app.config.dataDir))) : null;
  const children = owner ? childrenUse(await listChildren(ctx.app), (bodyId) => childDirOf(ctx.app, bodyId)) : [];
  const stalls = timePhase(ctx.request, "stalls", () => stallHour(loopWatch.tally(performance.now())));
  const nowMono = performance.now();
  const worst = stallBlame.worst(nowMono, HOUR_MS, WORST_STALLS);
  // Never waits on the cluster: the last reading, or the declared rows while the first read runs behind.
  const standsOn = footing.peek() ?? declaredFooting("the cluster is being read; reload in a moment");
  const rendering = performance.now();
  const r = regions(v);
  const at = (id: string): Html => raw(r[id]!);
  const help = disclosure("? How to read this", html`<div class="prose break" id="sys-help">
      <p>The machine now, updated in place about every 2 s over one event stream. Its history is on <a href="/boards">Boards</a> (the machine source).</p>
      ${caps}${processCaps}${selfHelp(self)}
      <p>Stalls are main-thread pauses past 200 ms, as of this page's load; <code>/metrics</code> has the series.</p>
      <p>Cache counts are since this process started. What each cache holds:</p>
      <ul>${pageCaches().map((c) => html`<li><strong>${c.name}</strong>: ${c.holds}</li>`)}</ul>
      <p>The forge samples its memory every minute, so the first hour of its chart appears shortly after a start.</p>
    </div>`, { id: "sys-more" });
  const body = html`<div class="page-head">
      <h1>System</h1>
      <span class="spacer"></span><a href="/system?pause">pause</a>
    </div>
    ${help}
    ${mayReadRefusals(ctx.auth.user) ? html`<p class="small"><a href="/forges/refused">Refused first asks</a></p>` : null}
    <div id="sys-dup">${at("sys-dup")}</div>
    <section class="settings-block"><h2>Machine</h2>
      <div id="summary" class="row-meta">${at("summary")}</div>
        <ul class="list" id="cores" aria-label="Per-core CPU, percent, with its last readings">${at("cores")}</ul>
        <ul class="list" id="mem">${at("mem")}</ul>
        ${capWords}
        ${egressLine}
        <p class="small mono" id="temps">${at("temps")}</p></section>
    ${selfSection(self)}
    ${childrenSection(children)}
    <section class="settings-block"><h2>Disks and network</h2>
      <ul class="list" id="sys-disks">${at("sys-disks")}</ul></section>
    <section class="settings-block"><h2>Processes</h2>
      <div class="js-only small muted">Sort by <button class="btn" data-size="sm" type="button" data-sort="cpu" aria-pressed="true"><kbd>c</kbd> CPU</button>
        <button class="btn" data-size="sm" type="button" data-sort="mem" aria-pressed="false"><kbd>m</kbd> memory</button></div>
      <div id="sys-procs" data-live-hold>${at("sys-procs")}</div></section>
    ${footingSection(standsOn)}
    ${featuresSection(timePhase(ctx.request, "features", () => featureHealth(ctx.app, reader)))}
    ${lagSection(lagMinutes.readings())}
    <div id="sys-stalls">${stallSection(stalls, worstStallsTable(worst, nowMono, Date.now()))}</div>
    <div id="sys-slow-pages">${slowPagesSection(timePhase(ctx.request, "slowpages", () => slowPagesCached(ctx.app.db)))}</div>
    <div id="sys-readers">${readersSection(readerPaces())}</div>
    <div id="sys-caches">${cachesSection(pageCaches())}</div>
    ${memory}`;
  const response = page({ ctx, title: "System", body, wide: true, scriptJs: systemLiveJs });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return response;
}
