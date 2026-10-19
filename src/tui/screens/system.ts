/**
 * The System command's dialog, the owner's (#1789): the machine now, in the
 * lines of `/system` — per-core CPU with its history, load, heat,
 * memory, swap, disks, disk and network rates, and the heaviest groups of
 * processes with their top two with the test files running in more than one check.
 * It reads `live().read()`, the same view the page and the API serve.
 * Read-only; Enter, Esc or q closes it.
 *
 * `memoryScreen` is `/system`'s other half (#2151): the forge's RSS beside
 * its JS heap, an hour a row for the last 24 h, read through `memoryHours`
 * like the page. The gate is the page's (`canSeeMemory`): anyone but a forge
 * admin who is a person gets no rows. Read-only.
 */

import type { Ctx, Screen } from "../app/app.ts";
import type { SystemView } from "../../system/view.ts";
import { canSeeMemory, memoryHours } from "../../boards/memory.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { bytes, spark } from "../../system/format.ts";
import { style } from "../term/style.ts";
import { pad, wrap } from "../term/width.ts";
import { dialog } from "../ui/widgets.ts";
import { Scroll, drawLines, hitScroll } from "./common.ts";

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

export function systemScreen(ctx: Ctx, lines: readonly string[]): Screen {
  return {
    title: "System",
    keys: [binding(["enter", "esc", "q"], "close")],
    render(area, s) {
      const buttons = dialog(s, area, ctx.theme.c, {
        title: "System",
        body: lines,
        actions: [{ label: "Close" }],
        selected: 0,
        width: WIDTH,
      });
      buttons.forEach((rect) => ctx.hit(rect, () => ctx.pop()));
    },
    key(e) {
      if (e.key === "enter" || e.key === "esc" || e.key === "q") ctx.pop();
      return true;
    },
  };
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
