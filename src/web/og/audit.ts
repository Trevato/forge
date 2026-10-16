/**
 * The audit's card: the policy score as a ring, and the top findings.
 *
 * The score is the share of apps that hold: an app holds when its
 * `contract.json` reads sound and its doors did not disagree with its table
 * the last time the forge knocked on them (an app never knocked on has not
 * disagreed). An app with no contract does not hold — it is unread, and an
 * audit that leaves out what it cannot read reads as a clean bill. So 3
 * sound apps of which one disobeys, plus one unread, is 2 of 4: 50%.
 *
 * Findings, worst first, three at most: an app that disobeys its table; a
 * contract that does not read; an app with doors open to anyone, the most
 * open first; and the unread apps, together on one line.
 *
 * Plain data in (`AuditRow`, read by the route as nobody), a card out.
 */

import type { CardInput } from "./card.ts";
import { scoreTone, type ScoreFigure } from "./score.ts";

const MAX_FINDINGS = 3;

const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

/** One app as the audit read it. */
export interface AuditRow {
  /** `owner/name`. */
  readonly name: string;
  readonly standing: "sound" | "unsound" | "unread";
  /** Doors the floor — anyone who can reach the app — may open. */
  readonly open: number;
  /** Why an unsound contract does not read. */
  readonly problems: readonly string[];
  /** The last probe found the doors disagreeing with the table. */
  readonly disobeys: boolean;
}

export const holds = (r: AuditRow): boolean => r.standing === "sound" && !r.disobeys;

/** The findings, worst first. */
export function findings(rows: readonly AuditRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) if (r.standing === "sound" && r.disobeys) out.push(`${r.name} disobeys its contract`);
  for (const r of rows)
    if (r.standing === "unsound")
      out.push(`${r.name}: unsound${r.problems[0] === undefined ? "" : ` — ${r.problems[0]}`}`);
  for (const r of rows
    .filter((r) => r.standing === "sound" && r.open > 0)
    .toSorted((a, b) => b.open - a.open || a.name.localeCompare(b.name)))
    out.push(`${r.name}: ${r.open} ${plural(r.open, "door")} open to anyone`);
  const unread = rows.filter((r) => r.standing === "unread");
  if (unread.length === 1) out.push(`${unread[0]!.name} has no contract.json`);
  else if (unread.length > 1) out.push(`${unread.length} apps have no contract.json`);
  return out;
}

/** The audit's card from the apps as read. */
export function auditInput(rows: readonly AuditRow[]): CardInput {
  const of = rows.length;
  if (of === 0)
    return {
      kind: "audit",
      title: "Audit",
      lines: ["No public apps to audit yet.", "An app's policy shows here once it has a contract."],
    };
  const held = rows.filter(holds).length;
  const sound = rows.filter((r) => r.standing === "sound").length;
  const unsound = rows.filter((r) => r.standing === "unsound").length;
  const unread = rows.filter((r) => r.standing === "unread").length;
  const open = rows.reduce((n, r) => n + (r.standing === "sound" ? r.open : 0), 0);
  const found = findings(rows);
  const figure: ScoreFigure = {
    kind: "score",
    held,
    of,
    caption: of === 1 ? `${held} of 1 app holds` : `${held} of ${of} apps hold`,
    tone: scoreTone(held, of),
  };
  return {
    kind: "audit",
    title: "Audit",
    lines: found.length === 0 ? ["Every app holds its contract."] : found.slice(0, MAX_FINDINGS),
    stat: [
      `${sound} read`,
      `${open} ${plural(open, "door")} open`,
      `${unsound} unsound`,
      `${unread} unread`,
    ].join(" · "),
    figure,
  };
}
