/**
 * A note's live state in one line (#8696). The planner decides each note on
 * its own — accept (it opened or amended issues), decline (nothing to
 * build), duplicate (the same ask as an earlier note) or snooze (opened, but
 * behind the Later gate) — and the line says which and why, then, for an
 * accepted note, how far it got: planned, building, in review, shipped (in
 * version N when the release is known). Every verdict has one tap that
 * overrules it (`actions/note_overrule.ts`). Plain data in, plain data out:
 * the page draws the words and links, escaping both.
 */

import { BUILDS, type StreamThought } from "./thought_stream.ts";

export type NotePhase = "waiting" | "planned" | "building" | "review" | "shipped" | "superseded" | "declined" | "duplicate" | "snoozed";

export interface NoteLink {
  readonly label: string;
  /** A path on this forge. */
  readonly href: string;
}

/** What one tap does to the planner's verdict. */
export type Overrule = { readonly do: "build" | "decline"; readonly label: string };

export interface NoteLine {
  /** The verdict while the planner's call stands, else where the accepted work is: the earliest phase among its issues. */
  readonly phase: NotePhase;
  readonly text: string;
  readonly links: readonly NoteLink[];
  readonly overrule: Overrule | null;
}

/** The version a merged pull of `repo` (owner/name) went out in, when known. */
export type VersionOf = (repo: string, pull: number) => string | undefined;

const ORDER: readonly NotePhase[] = ["planned", "building", "review", "shipped"];
const WORD: Record<NotePhase, string> = {
  waiting: "Waiting for the planner",
  planned: "Planned",
  building: "Building",
  review: "In review",
  shipped: "Shipped",
  superseded: "Superseded",
  declined: "Declined",
  duplicate: "Duplicate",
  snoozed: "Snoozed",
};
const BUILD: Overrule = { do: "build", label: "Build it anyway" };
const DECLINE: Overrule = { do: "decline", label: "Not this" };

export function noteLine(t: StreamThought, versionOf: VersionOf = () => undefined): NoteLine {
  if (t.placedAt === null) return { phase: "waiting", text: WORD.waiting, links: [], overrule: null };
  if (t.state === "superseded") return { phase: "superseded", text: WORD.superseded, links: [], overrule: null };
  const why = t.reply ?? "";
  const issues = t.placed.filter((x) => x.readable && BUILDS.has(x.action));
  const own = (x: (typeof issues)[number]) => ({ label: `#${x.number}`, href: `/${x.repo}/issues/${x.number}` });
  if (t.overruled === "declined")
    return { phase: "declined", text: "Declined by you", links: issues.map(own), overrule: null };
  if (t.overruled === null && issues.length === 0 && t.placed.every((x) => x.action !== "deferred"))
    return { phase: "declined", text: `Declined: ${why.replace(/^Declined:\s*/i, "") || "nothing to build"}`, links: [], overrule: BUILD };

  const links: NoteLink[] = [];
  const phases: NotePhase[] = [];
  let version: string | undefined;
  for (const x of issues) {
    const merged = x.pulls.find((p) => p.state === "merged");
    const open = x.pulls.find((p) => p.state === "open");
    phases.push(merged ? "shipped" : open ? "review" : x.running ? "building" : "planned");
    links.push(own(x));
    const pull = merged ?? open;
    if (pull) links.push({ label: `pull #${pull.number}`, href: `/${x.repo}/pulls/${pull.number}` });
    if (merged) version ??= versionOf(x.repo, merged.number);
  }
  const phase = ORDER.find((p) => phases.includes(p)) ?? "planned";
  const progress =
    issues.length === 1
      ? phase === "shipped" && version !== undefined
        ? `Shipped in version ${version}`
        : WORD[phase]
      : `${issues.length} issues: ${[...ORDER].reverse().flatMap((p) => {
          const n = phases.filter((q) => q === p).length;
          return n === 0 ? [] : [`${n} ${WORD[p].toLowerCase()}`];
        }).join(", ")}`;

  if (t.overruled === null && t.kind === "work" && t.placed.some((x) => x.action === "deferred"))
    return { phase: "snoozed", text: "Snoozed: you said it can wait", links, overrule: BUILD };
  if (t.overruled === null && t.repeats !== null)
    return { phase: "duplicate", text: `Duplicate: ${why} ${issues.length > 0 ? `(${progress.toLowerCase()})` : ""}`.trim(), links, overrule: BUILD };
  return { phase, text: progress, links, overrule: phase === "planned" && t.overruled === null && issues.some((x) => x.action === "opened") ? DECLINE : null };
}
