/**
 * A closed chapter's notes (#11603), written from what landed: plain sentences, grouped, each with
 * who built it and what it cost, then what was moved on. Pure text from plain data; no model.
 */

import type { Item } from "./chapters.ts";

export interface Figures {
  readonly opened: string;
  readonly closed: string;
  readonly days: number;
  readonly doneCount: number;
  readonly costUsd: number;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** Whole days from `a` to `b`, at least one. */
export function daysBetween(a: string, b: string): number {
  return Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000));
}

/** One sentence for a landed item. */
export function sentence(i: Item): string {
  const by = i.builder === null ? "" : ` Built by ${i.builder}.`;
  const cost = i.costUsd > 0 ? ` Cost ${usd(i.costUsd)}.` : "";
  const title = i.title.trim().replace(/[.\s]+$/, "");
  return `- ${title} (#${i.number}).${by}${cost}`;
}

/** The notes: fixes and additions grouped, then what moved to the next chapter. */
export function chapterNotes(
  name: string,
  means: string,
  landed: readonly { item: Item; fix: boolean }[],
  moved: readonly Item[],
  next: string | undefined,
  figures: Figures,
): string {
  const lines = [`# ${name}`, ""];
  if (means !== "") lines.push(means, "");
  lines.push(
    `Shipped ${figures.closed.slice(0, 10)}: ${figures.doneCount} ${figures.doneCount === 1 ? "item" : "items"} in ${figures.days} ${figures.days === 1 ? "day" : "days"}, costing ${usd(figures.costUsd)}.`,
    "",
  );
  const added = landed.filter((l) => !l.fix);
  const fixed = landed.filter((l) => l.fix);
  if (added.length > 0) lines.push("## Added", ...added.map((l) => sentence(l.item)), "");
  if (fixed.length > 0) lines.push("## Fixed", ...fixed.map((l) => sentence(l.item)), "");
  if (landed.length === 0) lines.push("Nothing had landed when this chapter closed.", "");
  if (moved.length > 0 && next !== undefined)
    lines.push(`## Moved to ${next}`, ...moved.map((m) => `- ${m.title.trim()} (#${m.number})`), "");
  return `${lines.join("\n").trimEnd()}\n`;
}
