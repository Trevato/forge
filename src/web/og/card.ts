/**
 * The social card — a pure function from {kind, title, lines, stat} to a
 * 1200×630 SVG string in the studio's dark theme tokens. No I/O, no
 * dependencies: the OG route and the OG designs fill this in.
 *
 * A card may carry a figure — the map's graph (`graph.ts`) or the audit's
 * score (`score.ts`) — drawn in a box on the right; the words then keep to
 * the left column, a little smaller, so the two never overlap.
 *
 * Every text is stripped of characters XML cannot carry, clamped to the
 * card's width by an estimated advance (system fonts are unmeasurable here,
 * so the estimate is deliberately wide), ended with an ellipsis, and only
 * then escaped.
 */

import { THEMES } from "../../design/themes.ts";
import { graphSvg, type GraphFigure } from "./graph.ts";
import { clean, escapeXml, fit } from "./xml.ts";
import { scoreSvg, type ScoreFigure } from "./score.ts";

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

export const CARD_KINDS = ["repo", "issue", "pull", "run", "app", "map", "audit", "page"] as const;
export type CardKind = (typeof CARD_KINDS)[number];

export type Figure = GraphFigure | ScoreFigure;

export { escapeXml, fit };

export interface CardInput {
  kind: CardKind;
  title: string;
  lines?: readonly string[];
  stat?: string;
  figure?: Figure;
}

const T = THEMES.dark.tokens;
const FONT = `system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`;
const MONO = `ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace`;

const PAD = 80;
const INNER = CARD_WIDTH - PAD * 2;
/** With a figure: the words' column, and the figure's box to its right. */
const COLUMN = 620;
export const FIGURE_BOX = { x: 760, y: 150, w: 360, h: 330 } as const;
const MAX_LINES = 3;
const TITLE_LINES = 2;
/** Widest average glyph advance, in em, for the bold sans: wider than the regular face. */
const EM_BOLD = 0.68;
const EM_MONO = 0.62;

const KIND_COLOR: Record<CardKind, string> = {
  repo: T.accent,
  issue: T.success,
  pull: T.merged,
  run: T.primary,
  app: T.attn,
  map: T.accent,
  audit: T.success,
  page: T.primary,
};

/** Break a title into at most `n` lines of `max` chars; the last is clamped. */
function wrap(text: string, size: number, n: number, em: number, width = INNER): string[] {
  const max = Math.max(1, Math.floor(width / (size * em)));
  const words = clean(text).split(" ").filter(Boolean);
  const rows: string[] = [];
  let cur = "";
  let i = 0;
  for (; i < words.length && rows.length < n; i++) {
    const w = words[i]!;
    const next = cur ? `${cur} ${w}` : w;
    if (Array.from(next).length <= max) {
      cur = next;
      continue;
    }
    if (cur) {
      rows.push(cur);
      cur = "";
      i--;
      continue;
    }
    rows.push(Array.from(w).slice(0, max).join("")); // one word wider than a row
    if (rows.length === n) break;
  }
  if (cur && rows.length < n) rows.push(cur);
  const rest = i < words.length || rows.join(" ").length < clean(text).length;
  if (rest && rows.length) {
    const last = rows.length - 1;
    rows[last] = fit(rows[last]! + "…", size, width, em);
    if (!rows[last]!.endsWith("…")) rows[last] += "…";
  }
  return rows.map((r) => fit(r, size, width, em));
}

function text(
  x: number,
  y: number,
  size: number,
  fill: string,
  body: string,
  extra = "",
): string {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}"${extra}>${escapeXml(body)}</text>`;
}

/** The figure's SVG, or nothing for an absent or unknown one. */
function drawFigure(figure: unknown): string {
  const f = figure as Figure | undefined;
  if (f?.kind === "graph") return graphSvg(f, FIGURE_BOX);
  if (f?.kind === "score") return scoreSvg(f, FIGURE_BOX);
  return "";
}

export function renderCard(input: CardInput): string {
  const kind: CardKind = CARD_KINDS.includes(input?.kind) ? input.kind : "page";
  const color = KIND_COLOR[kind];
  const out: string[] = [];

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" role="img" font-family="${FONT}">`,
    `<defs><linearGradient id="m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${THEMES.dark.tokens.accent}"/><stop offset="1" stop-color="${THEMES.dark.tokens.merged}"/></linearGradient></defs>`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${T.bg}"/>`,
    `<rect x="0" y="0" width="12" height="${CARD_HEIGHT}" fill="${color}"/>`,
    `<rect x="${PAD}" y="${PAD - 8}" width="44" height="44" rx="10" fill="url(#m)"/>`,
    text(PAD + 60, PAD + 26, 30, T.fg, "forge", ` font-weight="700"`),
  );

  // Kind badge, right-aligned in the header.
  const label = kind.toUpperCase();
  out.push(
    text(CARD_WIDTH - PAD, PAD + 24, 24, color, label, ` font-weight="700" text-anchor="end" letter-spacing="2"`),
  );

  const figure = drawFigure(input?.figure);
  const column = figure ? COLUMN : INNER;
  if (figure) out.push(figure);

  // Title: up to two lines, 64px bold (56px beside a figure).
  const tsize = figure ? 56 : 64;
  const title = wrap(input?.title ?? "", tsize, TITLE_LINES, EM_BOLD, column);
  let y = 270;
  for (const row of title) {
    out.push(text(PAD, y, tsize, T.fg, row, ` font-weight="700"`));
    y += tsize + 14;
  }

  // Supporting lines, 30px muted (26px beside a figure).
  const lines = (Array.isArray(input?.lines) ? input.lines : [])
    .map(clean)
    .filter(Boolean)
    .slice(0, MAX_LINES);
  const lsize = figure ? 26 : 30;
  y = Math.max(y + 10, 360);
  for (const l of lines) {
    out.push(text(PAD, y, lsize, T["muted-fg"], fit(l, lsize, column)));
    y += lsize + 14;
  }

  // Footer rule and stat.
  out.push(
    `<rect x="${PAD}" y="${CARD_HEIGHT - 110}" width="${INNER}" height="2" fill="${T.border}"/>`,
  );
  const stat = clean(input?.stat);
  if (stat) {
    out.push(
      text(PAD, CARD_HEIGHT - 52, 32, color, fit(stat, 32, INNER, EM_MONO), ` font-family="${MONO}" font-weight="600"`),
    );
  }
  out.push(`</svg>`);
  return out.join("");
}
