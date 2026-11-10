/**
 * The knobs (#10461): Speed, Weekly budget, Polish share, Autonomy per
 * repository, Feedback first. Plain data out: one row each with its name, a
 * line on what it does, the value, a control kind and its live effect. The
 * crew page, the terminal and the MCP `knobs` tool print these same rows;
 * `actions/knobs.ts` is the one place that turns them. Pace floor and queue
 * depth ride along as derived rows: Speed sets them, nothing else does. The
 * reserve is not one of them: it is what Weekly budget leaves (100 minus it),
 * so it moves with that dial and not with Speed.
 */

import type { App } from "../app.ts";
import { capacityValue, paceFloor, queueDepth } from "../core/capacity.ts";
import { labelsForIssues } from "../core/issues.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import { listActive } from "../core/runs.ts";
import { waitingOnPeople } from "./people_first.ts";
import { POLISH_SHARE_DEFAULT, isPolish, polishSpend } from "./polish_share.ts";
import { budgetEffect } from "./week_read.ts";

export type KnobId = "speed" | "budget" | "polish" | "autonomy" | "feedback" | "floor" | "depth";
/** The dials Speed sets: shown on the panel with their value, never turned there. */
export const DERIVED_KNOBS: readonly string[] = ["floor", "depth", "pace.floor", "queue.depth"];
export type AutonomyWord = "off" | "ask" | "go";
export const AUTONOMY_WORDS: readonly AutonomyWord[] = ["off", "ask", "go"];

export interface KnobRow {
  readonly id: KnobId;
  readonly name: string;
  readonly does: string;
  /** The value as typed back: a number, a percent's number, or one of the words. */
  readonly value: string;
  readonly control: "number" | "percent" | "words" | "fixed" | "derived";
  readonly min?: number;
  readonly max?: number;
  readonly words?: readonly string[];
  /** What it does right now, in a line. */
  readonly effect: string;
  /** For Autonomy: the repository (`owner/name`) this row is for. */
  readonly repo?: string;
}

/** A repository's autonomy in the knob's three words. */
export function autonomyWord(repo: Repo): AutonomyWord {
  if (repo.autonomy === "off") return "off";
  return !repo.plansNeedNod && repo.decisionsBy !== "me" ? "go" : "ask";
}

function runsLine(app: App): string {
  const active = listActive(app.db, "agent");
  const running = active.filter((r) => r.state === "running").length;
  return `${running} running · ${active.length - running} queued`;
}

function polishWaiting(app: App, repos: readonly Repo[]): number {
  let n = 0;
  for (const repo of repos) {
    const rows = app.db
      .query<{ id: string; title: string }, [string]>("SELECT id, title FROM issue WHERE repo_id = ?1 AND state = 'open' AND assignee_id IS NULL")
      .all(repo.id);
    const labels = labelsForIssues(app.db, rows.map((r) => r.id));
    n += rows.filter((r) => isPolish(r.title, (labels.get(r.id) ?? []).map((l) => l.name))).length;
  }
  return n;
}

/** The repositories the Autonomy knob lists: awake ones, those with the crew on first. */
export function knobRepos(app: App, limit = 12): Repo[] {
  return app.db
    .query<{ id: string }, [number]>("SELECT id FROM repo WHERE archived_at IS NULL ORDER BY autonomy = 'off', name LIMIT ?1")
    .all(limit)
    .flatMap((r) => getRepoById(app.db, r.id) ?? []);
}

/** The five knobs now (Autonomy is one row per repository). */
export function readKnobs(app: App, now: Date = new Date()): KnobRow[] {
  const repos = knobRepos(app);
  const live = repos.filter((r) => r.autonomy !== "off");
  const share = live[0]?.polishShare ?? POLISH_SHARE_DEFAULT;
  const spend = live[0] === undefined ? undefined : polishSpend(app.db, live[0].id, share, now);
  const waiting = waitingOnPeople(app.db, listActive(app.db, "agent").filter((r) => r.state === "queued"));
  const hhmm = waiting.since === null ? "" : ` since ${waiting.since.slice(11, 16)}`;
  const rows: KnobRow[] = [
    {
      id: "speed",
      name: "Speed",
      does: "How many crew runs go at once.",
      value: capacityValue(app.db, "crew.concurrency"),
      control: "number",
      min: 1,
      max: 16,
      effect: runsLine(app),
    },
    {
      id: "floor",
      name: "Pace floor",
      does: "The slots the pace always leaves reviews and assigned work. Derived from Speed: half of it, at least 1.",
      value: String(paceFloor(app.db)),
      control: "derived",
      effect: `${paceFloor(app.db)} slots`,
    },
    {
      id: "depth",
      name: "Queue depth",
      does: "How many merge-queue candidates of one repository gate at once. Derived from Speed: half of it rounded up, 1 to 4.",
      value: String(queueDepth(app.db)),
      control: "derived",
      effect: `${queueDepth(app.db)} candidates`,
    },
    {
      id: "budget",
      name: "Weekly budget",
      does: "How much of the week's subscription to use, evenly to the reset.",
      value: capacityValue(app.db, "week.use"),
      control: "percent",
      min: 10,
      max: 100,
      effect: budgetEffect(app, now),
    },
    {
      id: "polish",
      name: "Polish share",
      does: "The share of the week's spend polish may take.",
      value: String(share),
      control: "percent",
      min: 0,
      max: 50,
      effect: `polish ${spend === undefined ? 0 : Math.round(spend.percent)}% of this week's spend · ${polishWaiting(app, live)} polish issues waiting`,
    },
  ];
  for (const repo of repos) {
    const word = autonomyWord(repo);
    rows.push({
      id: "autonomy",
      name: "Autonomy",
      does: "off: the crew leaves it alone · ask: plans need a nod, decisions come to you · go: the decider answers, plans open.",
      value: word,
      control: "words",
      words: AUTONOMY_WORDS,
      repo: `${repo.ownerName}/${repo.name}`,
      effect: word === "off" ? "off · the crew does not work here" : `${word} · ${repo.autonomySlots} builder slots`,
    });
  }
  rows.push({
    id: "feedback",
    name: "Feedback first",
    does: "A person's comment, assignment or note from an app starts ahead of everything. Always on.",
    value: "on",
    control: "fixed",
    effect: waiting.count === 0 ? "nothing from a person waiting" : `${waiting.count} waiting${hhmm}`,
  });
  return rows;
}

/** The knobs as the plain lines the terminal and the MCP print. */
export function knobLines(rows: readonly KnobRow[]): string[] {
  return rows.map((r) => `${r.name}${r.repo === undefined ? "" : ` (${r.repo})`}: ${r.value}${r.control === "percent" ? "%" : ""} — ${r.effect}`);
}
