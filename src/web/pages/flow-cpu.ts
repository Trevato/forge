/**
 * /flow's CPU-stop block (#11904): one short line for the hour's checks stopped
 * for CPU and the pulls closed unmerged after such a stop, then one row per pull
 * (its link, when it closed), so a person can queue each again. Rows as the clog
 * rows above it: a `.list` of `row()`s, no box, no new class. Read by
 * `flow/cpu_stops.ts` and `flow/cpu_closed.ts`. Quiet draws nothing.
 */

import type { CpuClosedPull } from "../../flow/cpu_closed.ts";
import { html, type Html } from "../html.ts";
import { icon, row, time } from "../ui.ts";

const count = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** The count line: the hour's stops, the closed pulls, or both. */
export function cpuStopsSays(stopped: number, closed: number): string {
  const parts = [
    ...(stopped === 0 ? [] : [`${count(stopped, "check", "checks")} stopped for CPU in the last hour`]),
    ...(closed === 0 ? [] : [`${count(closed, "pull", "pulls")} closed unmerged after a CPU stop`]),
  ];
  return parts.length === 0 ? "" : `${parts.join("; ")}.`;
}

export function cpuStopsSection(stopped: number, closed: readonly CpuClosedPull[]): Html {
  if (stopped === 0 && closed.length === 0) return html``;
  return html`<div class="mb" id="flow-cpu-stops"><p>${cpuStopsSays(stopped, closed.length)}</p>
    ${closed.length === 0 ? "" : html`<ul class="list" id="flow-cpu-closed">${closed.map((p) => row({
      href: `/${p.repo}/pulls/${String(p.number)}`,
      lead: icon("pull"),
      title: `${p.repo} #${String(p.number)}`,
      meta: html`closed ${time(p.closedAt)}`,
      state: "closed",
    }))}</ul>`}</div>`;
}
