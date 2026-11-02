/**
 * The week's pipes drawn: sources on the left, a valve per repository in the
 * middle, shipped on the right, line width the real spend of the week —
 * SVG written here on the server, no client drawing. A pipe's width is its
 * dollars over the widest pipe's, up to `MAX_W` units; a pipe with no spend
 * (a note, a run that cost nothing) keeps a hairline so it can be seen. A
 * shut valve draws its outgoing pipe dashed and a share draws a half-open
 * gate. Colours are classes (`fg-sN`, `pipe-valve-*`), set in the stylesheet.
 */

import type { Pipes } from "../flow/pipes.ts";
import { html, type Html } from "./html.ts";

const W = 720;
const SOURCE_X = 150;
const VALVE_X = 380;
const SHIPPED_X = 600;
const ROW = 46;
const MAX_W = 26;
const HAIR = 2;

const money = (usd: number): string => (usd < 10 ? `$${usd.toFixed(2)}` : `$${Math.round(usd)}`);

const curve = (x1: number, y1: number, x2: number, y2: number): string => {
  const mid = (x1 + x2) / 2;
  return `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
};

export function pipesSvg(p: Pipes): Html {
  const sources = p.sources;
  const rows = Math.max(sources.length * 1.4, p.valves.length);
  const H = Math.round(rows * ROW) + 24;
  const widest = Math.max(0.01, ...p.flows.map((f) => f.usd), ...p.valves.map((v) => v.usd));
  const width = (usd: number): number => Math.max(HAIR, (usd / widest) * MAX_W);
  const sy = (i: number): number => 20 + ((H - 40) * (i + 0.5)) / sources.length;
  const vy = (i: number): number => 20 + ((H - 40) * (i + 0.5)) / Math.max(1, p.valves.length);
  const shippedY = H / 2;
  const at = new Map(p.valves.map((v, i) => [v.repoId, i]));
  const index = new Map(sources.map((s, i) => [s.source, i]));
  const pipes = p.flows.map((f) => {
    const i = index.get(f.source);
    const j = at.get(f.repoId);
    if (i === undefined || j === undefined) return null;
    return html`<path class="pipe fg-s${String(i)}" d="${curve(SOURCE_X, sy(i), VALVE_X - 14, vy(j))}" stroke-width="${width(f.usd).toFixed(1)}"><title>${f.source} to ${p.valves[j]!.slug}: ${money(f.usd)}, ${String(f.runs)} ${f.source === "notes" ? "notes" : "runs"}</title></path>`;
  });
  const out = p.valves.map(
    (v, j) => html`<path class="pipe pipe-out pipe-valve-${v.mode}" d="${curve(VALVE_X + 14, vy(j), SHIPPED_X - 10, shippedY)}" stroke-width="${width(v.usd).toFixed(1)}"><title>${v.slug} to shipped: ${money(v.usd)}, ${String(v.shipped)} shipped</title></path>`,
  );
  const labels = sources.map(
    (s, i) => html`<text class="pipe-label" x="${String(SOURCE_X - 10)}" y="${String(sy(i) + 4)}" text-anchor="end">${s.source === "notes" ? "your notes" : s.source} ${s.source === "notes" ? String(s.runs) : money(s.usd)}</text>`,
  );
  const valves = p.valves.map(
    (v, j) => html`<g class="pipe-valve pipe-valve-${v.mode}">
      <rect x="${String(VALVE_X - 14)}" y="${String(vy(j) - 12)}" width="28" height="24" rx="4" />
      <text class="pipe-label" x="${String(VALVE_X)}" y="${String(vy(j) + 4)}" text-anchor="middle">${v.mode === "open" ? "open" : v.mode === "shut" ? "shut" : `${String(v.level)}%`}</text>
      <text class="pipe-label pipe-repo" x="${String(VALVE_X)}" y="${String(vy(j) - 16)}" text-anchor="middle">${v.slug}</text>
    </g>`,
  );
  return html`<svg class="pipes" viewBox="0 0 ${String(W)} ${String(H)}" role="img" aria-label="The week's budget: ${money(p.usd)} spent by ${String(p.valves.length)} repositories, ${String(p.shipped)} pulls shipped. The table below has the same numbers.">
    ${pipes}${out}${valves}${labels}
    <text class="pipe-label" x="${String(SHIPPED_X + 10)}" y="${String(shippedY - 4)}">shipped</text>
    <text class="pipe-label" x="${String(SHIPPED_X + 10)}" y="${String(shippedY + 14)}">${String(p.shipped)} pulls</text>
  </svg>`;
}
