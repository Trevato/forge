/**
 * The System command's dialog, the owner's (#1789): the machine now, in the
 * lines of `/system` — per-core CPU with its history, load, heat,
 * memory, swap, disks, disk and network rates, and the heaviest groups of
 * processes with their top two with the test files running in more than one check.
 * It reads `live().read()`, the same view the page and the API serve.
 * Read-only; Enter, Esc or q closes it.
 *
 * Above the machine, the forge itself (#7296): `forgeLines` reads
 * `readHealth`, the answer MCP `health` gives the same user — version, short
 * commit, serving or draining, and one more line only when a rollout is not
 * simply fine or the platform reports incidents.
 *
 * `memoryScreen` is `/system`'s other half (#2151): the forge's RSS beside
 * its JS heap, an hour a row for the last 24 h, read through `memoryHours`
 * like the page. The gate is the page's (`canSeeMemory`): anyone but a forge
 * admin who is a person gets no rows. Read-only.
 */

import type { Ctx, Screen } from "../app/app.ts";
import type { SystemView } from "../../system/view.ts";
import { rolloutLine, type ForgeHealth } from "../../kernel/guard.ts";
import { canSeeMemory, memoryHours } from "../../boards/memory.ts";
import { telemetryReader } from "../../actions/telemetry.ts";
import { historyOver } from "../../system/telemetry.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { setTelemetryGrant } from "../../actions/telemetry.ts";
import { grantable } from "../../core/telemetry.ts";
import { bytes, spark } from "../../system/format.ts";
import { style } from "../term/style.ts";
import { pad, truncate, wrap } from "../term/width.ts";
import { dialog } from "../ui/widgets.ts";
import { Scroll, confirmScreen, drawLines, hitScroll, later, pickerScreen } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";
import { readHealth } from "../../actions/health.ts";
import { readerPaces } from "../../system/telemetry_reads.ts";
import { live as liveMachine } from "../../system/live.ts";

const WIDTH = 72;
const GROUPS = 6;
const CORES = 8;
const PROCS = 2;

const rate = (n: number | null): string => (n === null ? "—" : `${bytes(n)}/s`);

const pct = (n: number | null): string => (n === null ? "—" : `${n.toFixed(1)}%`);

/** The duplicate-work sentence, wrapped: the one /flow and /system say. */
export function duplicateLines(dups: SystemView["duplicates"], inner: number): string[] {
  return dups.length === 0
    ? ["No test file is running in more than one check."]
    : wrap(
        `${dups.length} test file${dups.length === 1 ? " is" : "s are"} running in more than one check: ${dups
          .slice(0, 3)
          .map((d) => `${d.file} (${d.checks.join(", ")})`)
          .join("; ")}`,
        inner,
      );
}

/** A cell's memory beside its cap and who holds it, as /system says it (#2410); the forge and the host have none. */
const capOf = (g: SystemView["groups"][number]): string =>
  g.capBytes === null ? "" : `${bytes(g.rssBytes)} of ${bytes(g.capBytes)} ${g.capBy === "kernel" ? "kernel" : "watched"}`;

/**
 * The forge as MCP `health` says it: the first line always, the second only
 * when there is something to say. A stranger's answer carries no rollout or
 * incidents, so it never has a second line.
 */
export function forgeLines(h: ReturnType<typeof readHealth>, inner = WIDTH - 6): string[] {
  const head = `forge ${h.version} · ${h.commit === null ? "no commit" : h.commit.slice(0, 7)} · ${h.draining ? "draining" : "serving"}`;
  if (!("incidents" in h)) return [head];
  const full = h as ForgeHealth;
  const rollout = rolloutLine(full);
  // `stuck` and `held` are the rollout's own words; the rest are incidents.
  const others = full.incidents.filter((i) => i.key !== "stuck" && i.key !== "held");
  const said = [
    ...(rollout === null ? [] : [rollout]),
    ...(others.length === 0
      ? []
      : [`${others.length} incident${others.length === 1 ? "" : "s"}: ${others.map((i) => `${i.key}: ${i.message}`).join("; ")}`]),
  ];
  return said.length === 0 ? [head] : [head, truncate(said.join(" · "), inner)];
}

export function systemLines(v: SystemView): string[] {
  const inner = WIDTH - 6;
  const cores = v.cpu.cores.slice(0, CORES).map(
    (c, i) => `${pad(`cpu${i}`, 6)} ${pad(c === null ? "—" : `${Math.round(c)}%`, 4, "right")} ${spark(v.cpu.history[i] ?? [])}`,
  );
  return [
    `CPU ${pct(v.cpu.busyPct)} over ${v.cpu.cores.length} cores · load ${v.load ? v.load.map((l) => l.toFixed(2)).join(" ") : "—"}`,
    ...cores,
    ...(v.cpu.cores.length > CORES ? [`… and ${v.cpu.cores.length - CORES} more cores`] : []),
    `hottest ${v.hottestC === null ? "—" : `${v.hottestC.toFixed(0)}°C`} · memory ${v.memory ? `${bytes(v.memory.usedBytes)} of ${bytes(v.memory.totalBytes)}` : "—"} · ${v.processes} processes`,
    `swap ${v.memory ? (v.memory.swapTotalBytes === 0 ? "none" : `${bytes(v.memory.swapUsedBytes)} of ${bytes(v.memory.swapTotalBytes)}`) : "—"}`,
    ...v.disks.map((d) => `${pad(d.mount, 20)} ${Math.round((d.usedBytes / Math.max(1, d.totalBytes)) * 100)}% of ${bytes(d.totalBytes)}`),
    ...v.io.map((d) => `${pad(d.name, 20)} R ${rate(d.readBytesPerSecond)}  W ${rate(d.writeBytesPerSecond)}`),
    ...v.net.map((n) => `${pad(n.name, 20)} ↓ ${rate(n.rxBytesPerSecond)}  ↑ ${rate(n.txBytesPerSecond)}`),
    "",
    ...v.groups.slice(0, GROUPS).flatMap((g) => [
      `${pad(g.label, 24)} ${pad(String(g.procs), 4, "right")} procs  ${capOf(g)}`.trimEnd(),
      ...g.top.slice(0, PROCS).map((p) => `  ${pad(p.comm, 16)} ${pad(p.cpuCores === null ? "—" : p.cpuCores.toFixed(2), 5, "right")} cores  ${bytes(p.rssBytes)}`),
    ]),
    "",
    ...duplicateLines(v.duplicates, inner),
  ];
}

/** The windows `h` cycles, in hours: the MCP `telemetry_history` tool's `hours`. */
export const WINDOWS = [1, 6, 24, 72] as const;
/** Seven for the label, this, and " now … · peak …" must fit the dialog's 66 inner columns. */
const SPARK_COLUMNS = 20;

/** At most `n` readings, each the mean of its stretch, so a long window still fits the line. */
function shrink(xs: readonly number[], n: number): number[] {
  if (xs.length <= n) return [...xs];
  return Array.from({ length: n }, (_, i) => {
    const part = xs.slice(Math.floor((i * xs.length) / n), Math.floor(((i + 1) * xs.length) / n));
    return part.reduce((a, b) => a + b, 0) / part.length;
  });
}

/**
 * CPU, memory and load of the node over the last `hours`, one sparkline each (scaled to its own peak),
 * with the latest value and the peak in words. Empty for anyone `telemetry_history` refuses;
 * `no readings yet` when nothing is recorded.
 */
export function historyLines(session: Session, hours: number): string[] {
  if (!telemetryReader(session.app, session.user)) return [];
  const head = `Last ${hours} h (h: 1 / 6 / 24 / 72)`;
  const points = historyOver(session.app, hours).filter((p) => p.target === "node");
  const series: [string, (p: (typeof points)[number]) => number | null, (n: number) => string][] = [
    ["CPU", (p) => p.cpuCoresMax, (n) => `${n.toFixed(2)} cores`],
    ["memory", (p) => p.memoryBytes, bytes],
    ["load", (p) => p.load, (n) => n.toFixed(2)],
  ];
  const rows = series.map(([label, pick, say]) => {
    const xs = points.map(pick).filter((x): x is number => x !== null);
    if (xs.length === 0) return `${pad(label, 7)} no readings yet`;
    const peak = Math.max(...xs);
    const scaled = shrink(xs, SPARK_COLUMNS).map((x) => (peak > 0 ? (x / peak) * 100 : 0));
    return `${pad(label, 7)} ${pad(spark(scaled), SPARK_COLUMNS)} now ${say(xs[xs.length - 1]!)} · peak ${say(peak)}`;
  });
  return [head, ...rows];
}

/** Who may grant telemetry:read: the MCP tool's gate (`mayBoards`), a forge admin who is a person. */
const mayGrant = (session: Session | undefined): boolean => session?.user?.isAdmin === true && session.user.kind !== "agent";

const READER_ROWS = 6;

/**
 * Who read the telemetry routes in the last 10 minutes and how fast, as /system's
 * "Telemetry readers" section says it (#9069): route, reader, reads, mean interval,
 * and a flag for a flow reader under 5 s. Empty for anyone but a forge admin who is a person.
 */
export function readerLines(session: Session, now = Date.now()): string[] {
  if (!mayGrant(session)) return [];
  const rows = readerPaces(now);
  if (rows.length === 0) return ["Telemetry readers: none in the last 10 minutes"];
  const secs = (ms: number | null): string => (ms === null ? "—" : `${(ms / 1000).toFixed(1)} s`);
  return [
    "Telemetry readers, last 10 min (route, reader, reads, mean interval)",
    ...rows.slice(0, READER_ROWS).map((r) =>
      truncate(`${pad(r.route, 7)} ${pad(r.reader, 22)} ${pad(String(r.reads), 5, "right")} ${pad(secs(r.meanIntervalMs), 8, "right")}${r.tooFast ? "  TOO FAST" : ""}`, WIDTH - 6),
    ),
    ...(rows.length > READER_ROWS ? [`… and ${rows.length - READER_ROWS} more`] : []),
  ];
}

/** The agents holding the grant, in one line. */
export function grantLine(session: Session): string {
  const held = grantable(session.db).filter((a) => a.granted).map((a) => a.username);
  return held.length === 0 ? "telemetry:read held by: no agent" : `telemetry:read held by: ${held.join(", ")}`;
}

/** The words for a refused grant, as MCP `telemetry_grant` says them. */
const grantRefused = (error: "not_found" | "not_an_agent"): string =>
  error === "not_an_agent" ? "Only an agent account can be granted telemetry:read." : "no such account";

export function systemScreen(ctx: Ctx, lines: readonly string[], session: Session): Screen {
  let span = 1; // index into WINDOWS; 1 is the default 6 h window
  // read on open and when `h` moves the window, not on every paint
  let history = historyLines(session, WINDOWS[span]!);
  const offered = mayGrant(session);
  const askGrant = (): void => {
    if (!mayGrant(session)) return ctx.toast("telemetry:read is a forge admin's to grant", "danger");
    const agents = grantable(session.db);
    if (agents.length === 0) return ctx.toast("No agent accounts yet");
    later(ctx, () =>
      pickerScreen(ctx, screen, {
        title: "Grant telemetry:read to",
        items: agents.map((a) => ({ id: a.username, label: a.username, hint: a.granted ? "granted" : "not granted" })),
        onPick: ([name]) => {
          const target = agents.find((a) => a.username === name);
          if (!target) return;
          const on = !target.granted;
          later(ctx, () =>
            confirmScreen(ctx, screen, {
              title: "Telemetry",
              body: [on ? `grant ${target.username} telemetry:read? y/n` : `take back ${target.username} telemetry:read? y/n`],
              actions: [{ label: "y" }, { label: "n" }],
              selected: 1,
              onChoose: (choice) => {
                if (choice !== 0) return;
                const set = setTelemetryGrant(session.app, session.user, target.username, on);
                if (!set.ok) return ctx.toast(grantRefused(set.error), "danger");
                ctx.toast(`${target.username} ${on ? "may now read" : "no longer reads"} telemetry.`);
              },
            }),
          );
        },
      }),
    );
  };
  const screen: Screen = {
    title: "System",
    keys: [binding(["h"], "window"), ...(offered ? [binding(["g"], "grant or take back telemetry")] : []), binding(["enter", "esc", "q"], "close")],
    render(area, s) {
      const buttons = dialog(s, area, ctx.theme.c, {
        title: "System",
        body: [
          ...lines,
          "",
          ...history,
          ...(offered ? ["", ...readerLines(session)] : []),
          ...(offered ? ["", grantLine(session), "g: grant or take back telemetry:read"] : []),
        ],
        actions: [{ label: "Close" }],
        selected: 0,
        width: WIDTH,
      });
      buttons.forEach((rect) => ctx.hit(rect, () => ctx.pop()));
    },
    key(e) {
      if (e.key === "h") {
        span = (span + 1) % WINDOWS.length;
        history = historyLines(session, WINDOWS[span]!);
      } else if (e.key === "g") askGrant();
      else if (e.key === "enter" || e.key === "esc" || e.key === "q") ctx.pop();
      return true;
    },
  };
  return screen;
}

const mib = (n: number) => `${(n / 1_048_576).toFixed(1)}`;

/** The header, then an hour a row (UTC); empty for anyone the gate refuses. */
export function memoryLines(session: Session, now = Date.now()): string[] {
  if (!canSeeMemory(session.user)) return [];
  const hours = memoryHours(session.db, now);
  if (hours.length === 0) return ["No samples yet; the forge samples its memory every minute."];
  const col = (s: string) => pad(s, 10, "right");
  return [
    `${pad("Hour (UTC)", 17)}${col("RSS mean")}${col("RSS max")}${col("Heap mean")}${col("Heap max")}  MiB`,
    ...hours.map(
      (h) =>
        `${pad(new Date(h.at).toISOString().slice(0, 16).replace("T", " "), 17)}${col(mib(h.rssMean))}${col(mib(h.rssMax))}${col(mib(h.heapMean))}${col(mib(h.heapMax))}`,
    ),
  ];
}

export function memoryScreen(session: Session, ctx: Ctx): Screen {
  const scroll = new Scroll();
  return {
    title: "System memory",
    keys: [binding(["j", "k"], "scroll"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const lines = memoryLines(session);
      const spans = lines.map((text, i) => [{ text, style: style(i === 0 ? c.fg : c.mutedFg, c.bg) }]);
      drawLines(s, area, c, scroll, spans);
      hitScroll(ctx, area, scroll, lines.length);
    },
    key(e) {
      if (scroll.key(e, memoryLines(session).length)) return true;
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return false;
    },
  };
}

/** The machine, as /system says it, and which agents may read it: the owner's, a person (#1789). */
export const entry: PaletteEntry = {
  id: "system",
  title: "System",
  hint: "the machine now: CPU, memory, disks, processes",
  after: ["flow", "system-memory", "boards"],
  offered: (session) => session.user?.isAdmin === true && session.user.kind !== "agent",
  run: (session, ctx) => ctx.push(systemScreen(ctx, [
    ...forgeLines(readHealth(session.app, session.user)),
    "",
    ...systemLines(liveMachine().read()),
  ], session)),
};
