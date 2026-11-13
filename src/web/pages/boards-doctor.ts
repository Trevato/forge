/**
 * The batch doctor's last acts (#7555), for the flow panel: the newest ten
 * across the repositories the reader may see, one row each with when, the
 * culprit pull, what the doctor did and how it classed the red. A sealed
 * pull is named only as `a sealed pull`, with no probe; one read
 * (`recentDoctorRuns`).
 */

import type { Database } from "bun:sqlite";
import { recentDoctorRuns, type DoctorRun } from "../../checks/doctor.ts";
import { span } from "../../flow/pipeline.ts";
import { html, type Html } from "../html.ts";
import { badge, row } from "../ui.ts";
import { fold } from "../figure.ts";

/** The most runs the card lists. */
export const DOCTOR_LISTED = 10;

function runRow(repo: string, run: DoctorRun, now: number): Html {
  const tone = run.action === "held" ? "danger" : "default";
  return row({
    data: { doctor: run.action },
    title: html`${run.sealed || run.culprit === null ? html`<span class="muted">a sealed pull</span>` : html`<a href="/${repo}/pulls/${String(run.culprit)}">#${String(run.culprit)}</a>`} ${badge(run.action, { tone })}`,
    meta: html`${span(Math.max(0, now - Date.parse(run.at)))} ago · ${repo} · ${run.class}`,
    ...(run.probe === "" ? {} : { facts: [{ label: "error", value: html`<span class="break">${run.probe}</span>` }] }),
  });
}

/** The "Batch doctor" card: nothing until the doctor has treated a red (an empty card is one more note on a page held to a count). */
export function doctorCard(db: Database, owner: boolean, now: number): Html {
  const top = recentDoctorRuns(db, owner, DOCTOR_LISTED);
  if (top.length === 0) return html``;
  const held = top.filter((l) => l.run.action === "held").length;
  return fold("Batch doctor", `${String(top.length)} recent ${top.length === 1 ? "run" : "runs"}, ${String(held)} held a pull`, html`<p class="muted">When a merge gate finds a pull red on its own, the doctor names the failing test and holds the pull until it passes.</p><ul class="list">${top.map((l) => runRow(l.repo, l.run, now))}</ul>`, { id: "doctor" });
}
