/**
 * A sync report, as something you can read in a second.
 *
 * One row per repo, five columns, and colour used for exactly one thing:
 * marking the rows that want your attention. A repo that is clean, current
 * and fetched should be visually silent — the whole value of the report is
 * that the exceptions stand out of it.
 */

import { G } from "../tui/term/screen.ts";
import { BOLD, DIM } from "../tui/term/style.ts";
import { AHEAD, trackText } from "../tui/local/common.ts";
import { cell, type Cell, type Out } from "./out.ts";
import { isDirty, type RepoReport, type SyncReport } from "./sync.ts";

export function printReport(out: Out, report: SyncReport): void {
  if (report.repos.length === 0) {
    out.line(
      out.paint(
        "Nothing pinned yet. `forge pin owner/name` picks a repo to keep here.",
        out.c.mutedFg,
      ),
    );
    return;
  }
  if (report.pinsUnavailable)
    out.line(
      out.paint(
        "This forge has no pins yet — showing every repo you own.",
        out.c.faint,
      ),
    );

  out.table(
    [
      { header: "REPO", max: 44 },
      { header: "BRANCH", max: 24 },
      { header: "SYNC", align: "right" },
      { header: "DIRTY", align: "right" },
      { header: "STATE", max: 28 },
      { header: "FETCHED", align: "right" },
    ],
    report.repos.map((r) => row(out, r)),
  );

  const attention = report.repos.filter(needsAttention);
  if (attention.length > 0) out.line();
  for (const r of attention) {
    if (r.error !== null)
      out.line(
        `${out.paint(G.cross, out.c.danger)} ${name(r)}: ${firstLine(r.error)}`,
      );
    else if (!r.present)
      out.line(
        `${out.paint(G.ring, out.c.attn)} ${name(r)}: not cloned yet — run \`forge sync\``,
      );
    else if (r.unpushed.length > 0)
      out.line(
        `${out.paint(AHEAD, out.c.attn)} ${name(r)}: ${r.unpushed.join(", ")} not on the workbench`,
      );
  }
}

function needsAttention(r: RepoReport): boolean {
  return r.error !== null || !r.present || r.unpushed.length > 0;
}

function name(r: RepoReport): string {
  return `${r.owner}/${r.name}`;
}

/** How many files are in the way of a clean pull — one number, not a list. */
export function dirtyCount(r: RepoReport): number {
  return r.staged + r.changed + r.untracked + r.conflicted;
}

/**
 * Nothing to say about this repo: cloned, clean, level with its upstream and
 * holding nothing back. That silence is the report's whole point — whatever
 * is left on the page is a thing to look at — so it gets one tick.
 */
export function settled(r: RepoReport): boolean {
  return (
    r.present &&
    r.error === null &&
    dirtyCount(r) === 0 &&
    r.ahead === 0 &&
    r.behind === 0 &&
    r.stashes === 0 &&
    r.upstream !== null
  );
}

function row(out: Out, r: RepoReport): Cell[] {
  const c = out.c;
  if (!r.present)
    return [
      cell(name(r), c.mutedFg),
      cell("—", c.faint),
      cell("", c.faint),
      cell("", c.faint),
      cell(r.error === null ? "not cloned" : "clone failed", c.attn),
      cell("", c.faint),
    ];

  const state: string[] = [];
  if (r.conflicted > 0) state.push(`${r.conflicted} conflicted`);
  if (r.stashes > 0) state.push(`${r.stashes} stashed`);
  if (r.fastForwarded) state.push("fast-forwarded");
  if (r.cloned) state.push("cloned");
  if (r.upstream === null) state.push("no upstream");
  if (r.note !== undefined) state.push("no token sent");
  if (r.error !== null) state.push("failed");

  const tone =
    r.error !== null || r.conflicted > 0
      ? c.danger
      : r.behind > 0
        ? c.attn
        : isDirty(r)
          ? c.accent
          : c.mutedFg;
  const dirty = dirtyCount(r);
  const sync = trackText(r.ahead, r.behind);

  return [
    cell(name(r), r.pinned ? c.fg : c.mutedFg, r.pinned ? 0 : DIM),
    cell(r.branch ?? "detached", c.mutedFg),
    cell(sync, sync === "" ? c.faint : tone, BOLD),
    cell(dirty === 0 ? "" : String(dirty), dirty === 0 ? c.faint : c.accent),
    settled(r) && state.length === 0
      ? cell(G.check, c.success)
      : cell(state.join(", "), state.length === 0 ? c.faint : tone),
    cell(since(r.lastFetch), c.faint),
  ];
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? text
  );
}

const UNITS: readonly (readonly [number, string])[] = [
  [86_400_000, "d"],
  [3_600_000, "h"],
  [60_000, "m"],
];

/** "3d", "2h", "now", or "never" — the same vocabulary as the TUI's clock. */
export function since(when: Date | null): string {
  if (when === null) return "never";
  const ms = Date.now() - when.getTime();
  for (const [size, suffix] of UNITS)
    if (ms >= size) return `${Math.floor(ms / size)}${suffix}`;
  return "now";
}
