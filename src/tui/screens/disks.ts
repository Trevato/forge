/**
 * Disk readings in the terminal, the owner's (#10465): pick a machine, then a
 * row a device — model, bytes written in the last 30 days, the date rated TBW
 * is projected at that rate, and what the assessment says. Ratings are vendor
 * figures; the date is a projection, not an alert. Read-only; the gate is
 * `mayHandleDisks`.
 */

import { mayHandleDisks, readMachine, readMachines } from "../../actions/disk_readings.ts";
import { printable, type MachineSummary } from "../../machines/disk_readings.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { Scroll, blank, drawLines, hitScroll, pickerScreen } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const tb = (bytes: number): string => `${(bytes / 1e12).toFixed(2)} TB`;

/**
 * Header lines, then one line per device with its reasons beneath; every line stripped of
 * control characters, since model, firmware and cpu are a machine's own text.
 */
export function diskLines(s: MachineSummary): string[] {
  const lines = [`${s.machine}: ${s.cpu ?? "cpu unknown"}, ${s.memoryBytes === null ? "memory unknown" : `${(s.memoryBytes / 1e9).toFixed(0)} GB`}`];
  if (s.devices.length === 0) lines.push("No readings yet.");
  for (const d of s.devices) {
    if (d.kind === "behind-controller") {
      lines.push(`${d.device}: behind a controller; not readable here`);
      continue;
    }
    const rate = d.bytesWrittenInWindow === null ? "no rate yet" : `${tb(d.bytesWrittenInWindow)} in ${d.spanDays!.toFixed(1)} d`;
    const date = d.ratedReachedAt === null ? "no projected date" : `rated TBW ${d.ratedReachedAt}`;
    lines.push(`${d.device}: ${d.inventory.model} ${d.inventory.firmware} · ${rate} · ${date} · ${d.assessment.level}`);
    for (const r of d.assessment.reasons) lines.push(`    ${r}`);
  }
  return lines.map(printable);
}

function readingScreen(session: Session, ctx: Ctx, machine: string): Screen {
  const scroll = new Scroll();
  const lines = (): string[] => {
    const r = readMachine(session.app, session.user, machine);
    return r.ok ? diskLines(r.value) : [];
  };
  return {
    title: `Disks: ${machine}`,
    keys: [binding(["j", "k"], "scroll"), binding(["esc", "q"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const all = lines();
      drawLines(s, area, c, scroll, all.map((text, i) => [{ text, style: style(i === 0 ? c.fg : c.mutedFg, c.bg) }]));
      hitScroll(ctx, area, scroll, all.length);
    },
    key(e) {
      if (scroll.key(e, lines().length)) return true;
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return false;
    },
  };
}

export const entry: PaletteEntry = {
  id: "disks",
  title: "Disks",
  hint: "machines' disk readings: 30-day write rate and projected rated-TBW date",
  after: ["system"],
  offered: (session) => mayHandleDisks(session.user),
  run: (session, ctx) => {
    const names = readMachines(session.app, session.user);
    if (!names.ok || names.value.length === 0) return ctx.toast("No disk readings yet");
    ctx.push(
      pickerScreen(ctx, blank("Disks"), {
        title: "Disks: machine",
        items: names.value.map((m) => ({ id: m, label: m, hint: "" })),
        onPick: ([m]) => {
          if (m) ctx.push(readingScreen(session, ctx, m));
        },
      }),
    );
  },
};
