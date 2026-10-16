/**
 * A score as a ring: the share of a whole, the arc filled clockwise from
 * twelve o'clock, the number in the middle and what it counts underneath.
 * The audit's card draws its policy score with it (`audit.ts`).
 *
 * The arc is one circle with a dash as long as the share of its
 * circumference — no path arithmetic, so 0 and 100 are exact.
 */

import { THEMES } from "../../design/themes.ts";
import { escapeXml, fit } from "./xml.ts";
import { px, type Box } from "./graph.ts";

const T = THEMES.dark.tokens;

export type ScoreTone = "success" | "attn" | "danger";

export interface ScoreFigure {
  readonly kind: "score";
  /** What is counted towards the score, and out of how many. */
  readonly held: number;
  readonly of: number;
  /** Under the ring: what the number counts. */
  readonly caption: string;
  readonly tone: ScoreTone;
}

/** The score as a whole percent: held / of × 100, rounded; nothing to count is 0. */
export function percent(held: number, of: number): number {
  if (!(of > 0) || !Number.isFinite(held)) return 0;
  return Math.round((Math.min(Math.max(held, 0), of) / of) * 100);
}

/** 100% is success, half or more is attention, below half is danger. */
export function scoreTone(held: number, of: number): ScoreTone {
  const p = percent(held, of);
  return p === 100 ? "success" : p >= 50 ? "attn" : "danger";
}

const STROKE = 26;
const CAPTION = 24;
/** Digits and "%" in the bold sans run wide: 0.8 em each keeps the number off the stroke. */
const EM_NUMBER = 0.8;

export function scoreSvg(fig: ScoreFigure, box: Box): string {
  const r = Math.min(box.w, box.h - 60) / 2 - STROKE / 2;
  const cx = box.x + box.w / 2;
  const cy = box.y + r + STROKE / 2;
  const counted = fig.of > 0;
  const share = counted ? Math.min(Math.max(fig.held, 0), fig.of) / fig.of : 0;
  const circ = 2 * Math.PI * r;
  const label = counted ? `${percent(fig.held, fig.of)}%` : "—";
  const color = T[fig.tone] ?? T.attn;
  // The number fills the ring's middle with a stroke's width to spare each side.
  const hole = 2 * r - STROKE * 3;
  const size = Math.min(84, Math.floor(hole / (label.length * EM_NUMBER)));
  return [
    `<circle cx="${px(cx)}" cy="${px(cy)}" r="${px(r)}" fill="none" stroke="${T.border}" stroke-width="${STROKE}"/>`,
    share <= 0
      ? ""
      : `<circle cx="${px(cx)}" cy="${px(cy)}" r="${px(r)}" fill="none" stroke="${color}" stroke-width="${STROKE}" stroke-dasharray="${px(circ * share)} ${px(circ)}" transform="rotate(-90 ${px(cx)} ${px(cy)})"/>`,
    `<text x="${px(cx)}" y="${px(cy + size * 0.36)}" font-size="${size}" font-weight="700" text-anchor="middle" fill="${counted ? T.fg : T["muted-fg"]}">${escapeXml(label)}</text>`,
    `<text x="${px(cx)}" y="${px(cy + r + STROKE / 2 + 40)}" font-size="${CAPTION}" text-anchor="middle" fill="${T["muted-fg"]}">${escapeXml(fit(fig.caption, CAPTION, box.w))}</text>`,
  ].join("");
}
