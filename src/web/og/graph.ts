/**
 * The map as a thumbnail: the same layout the map page draws (`layout` in
 * `web/pages/map.ts` — a card one level below its deepest blocker, long
 * edges routed down the gutters), shrunk into a box, with the titles left
 * out because nobody reads 9 px type in a chat bubble. What is left is the
 * shape of the plan: each card filled by its word, and the critical path —
 * its cards and its edges — in the accent.
 *
 *   ready    success, outlined       working   accent, solid
 *   blocked  grey, filled            waiting   merged, outlined
 *   held     merged, dashed          parked    attn, outlined
 *   deferred faint, dashed           done      faint, outlined
 *
 * The proportions are the page's own (a 196 × 68 card, 28 across and 44
 * down between them), so the thumbnail is the page seen from far away.
 * Plain data in, an SVG fragment out.
 */

import { THEMES } from "../../design/themes.ts";
import type { Word } from "../pages/map.ts";

const T = THEMES.dark.tokens;

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface GraphNode {
  readonly level: number;
  readonly slot: number;
  readonly word: Word;
  readonly critical: boolean;
}

/** A spot a long edge passes through: a gutter at a level, shared by `lanes` lines. */
export interface GraphVia {
  readonly level: number;
  readonly gutter: number;
  readonly lane: number;
  readonly lanes: number;
}

export interface GraphEdge {
  /** Indices into `nodes`: the blocker, then what it holds up. */
  readonly from: number;
  readonly to: number;
  readonly via: readonly GraphVia[];
  readonly critical: boolean;
  /** Either end is closed: drawn faint. */
  readonly done: boolean;
}

export interface GraphFigure {
  readonly kind: "graph";
  /** The widest level, in slots. */
  readonly width: number;
  readonly levels: number;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

const W = 196;
const H = 68;
const GX = 28;
const GY = 44;
const LANE = 6;
/** No bigger than this, so a plan of two cards is not two slabs. */
const MAX_SCALE = 0.62;

/** Two decimals, and never `NaN` into an attribute. */
export function px(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "0";
}

/** The scale that fits a `width` × `levels` grid in the box: the smaller ratio, capped. */
export function graphScale(width: number, levels: number, box: Box): number {
  const w = Math.max(1, width) * (W + GX) - GX;
  const h = Math.max(1, levels) * (H + GY) - GY;
  return Math.min(box.w / w, box.h / h, MAX_SCALE);
}

function look(word: Word): { fill: string; stroke: string; dash?: boolean } {
  switch (word) {
    case "ready":
      return { fill: T.card, stroke: T.success };
    case "working":
      return { fill: T.accent, stroke: T.accent };
    case "blocked":
      return { fill: T.border, stroke: T["border-strong"] };
    case "waiting":
      return { fill: T.card, stroke: T.merged };
    case "held":
      return { fill: T.card, stroke: T.merged, dash: true };
    case "parked":
      return { fill: T.card, stroke: T.attn };
    case "deferred":
      return { fill: T.bg, stroke: T["border-strong"], dash: true };
    default:
      return { fill: T.bg, stroke: T.border };
  }
}

export function graphSvg(fig: GraphFigure, box: Box): string {
  const nodes = Array.isArray(fig.nodes) ? fig.nodes : [];
  if (nodes.length === 0) return "";
  const s = graphScale(fig.width, fig.levels, box);
  const dw = (Math.max(1, fig.width) * (W + GX) - GX) * s;
  const dh = (Math.max(1, fig.levels) * (H + GY) - GY) * s;
  // Centred in the box: a short plan floats in the middle, a tall one fills it.
  const ox = box.x + (box.w - dw) / 2;
  const oy = box.y + Math.max(0, (box.h - dh) / 2);
  const x = (slot: number): number => ox + slot * (W + GX) * s;
  const y = (level: number): number => oy + level * (H + GY) * s;
  const gx = (v: GraphVia): number =>
    x(v.gutter) - (GX / 2) * s + (v.lane - (v.lanes - 1) / 2) * LANE * s;
  const w = W * s;
  const h = H * s;
  const line = Math.max(1.5, Math.min(3, 4 * s));

  const edges = (Array.isArray(fig.edges) ? fig.edges : [])
    // The critical path last, so it is drawn over what it crosses.
    .toSorted((a, b) => Number(a.critical) - Number(b.critical))
    .map((e) => {
      const from = nodes[e.from];
      const to = nodes[e.to];
      if (from === undefined || to === undefined) return "";
      let cx = x(from.slot) + w / 2;
      let cy = y(from.level) + h;
      let d = `M${px(cx)} ${px(cy)}`;
      const hop = (nx: number, ny: number): void => {
        const bend = (ny - cy) / 2;
        d += `C${px(cx)} ${px(cy + bend)} ${px(nx)} ${px(ny - bend)} ${px(nx)} ${px(ny)}`;
        cx = nx;
        cy = ny;
      };
      for (const v of e.via) {
        const vx = gx(v);
        hop(vx, y(v.level));
        cy = y(v.level) + h;
        d += `L${px(vx)} ${px(cy)}`;
      }
      hop(x(to.slot) + w / 2, y(to.level));
      const stroke = e.critical ? T.accent : e.done ? T.border : T["border-strong"];
      return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${px(e.critical ? line * 1.6 : line)}"/>`;
    })
    .join("");

  const cards = nodes
    .map((n) => {
      const c = look(n.word);
      const stroke = n.critical && n.word !== "working" ? T.accent : c.stroke;
      const sw = n.critical ? line * 1.6 : line;
      const dash = c.dash && !n.critical ? ` stroke-dasharray="${px(sw * 3)} ${px(sw * 2)}"` : "";
      return `<rect x="${px(x(n.slot))}" y="${px(y(n.level))}" width="${px(w)}" height="${px(h)}" rx="${px(Math.min(10, 8 * s + 1))}" fill="${c.fill}" stroke="${stroke}" stroke-width="${px(sw)}"${dash}/>`;
    })
    .join("");

  return `<g>${edges}${cards}</g>`;
}
