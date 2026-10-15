/**
 * A line chart as an SVG string: a pure function from points to markup, no
 * I/O, no dependencies, drawn the way `web/og/card.ts` draws. The viewBox is
 * fixed and the element carries its aspect ratio, so the space is held
 * before the first paint and nothing shifts. Colour is `currentColor`; every
 * label is stripped of what XML cannot carry, clamped, then escaped.
 */
import { escapeXml } from "../web/og/card.ts";

export type Point = { label: string; value: number; href?: string };

export const CHART_WIDTH = 720;
export const CHART_HEIGHT = 260;
const LEFT = 56;
const RIGHT = 16;
const TOP = 16;
const BOTTOM = 40;
const MAX_LABEL = 16;
const X_TICKS = 6;

const clean = (s: string) =>
  s.replace(/[^\u0009\u000A\u000D -퟿-�]/gu, "").replace(/\s+/g, " ").trim();
const clamp = (s: string, n = MAX_LABEL) => {
  const c = clean(s);
  return c.length > n ? `${c.slice(0, n - 1)}…` : c;
};
const num = (n: number) => String(Math.round(n * 100) / 100);

/** A short, readable number for an axis. */
export function formatValue(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${num(v / 1e9)}G`;
  if (a >= 1e6) return `${num(v / 1e6)}M`;
  if (a >= 1e4) return `${num(v / 1e3)}k`;
  return num(v);
}

export function lineChart(points: readonly Point[], title: string): string {
  const w = CHART_WIDTH - LEFT - RIGHT;
  const h = CHART_HEIGHT - TOP - BOTTOM;
  const max = Math.max(0, ...points.map((p) => p.value));
  const min = Math.min(0, ...points.map((p) => p.value));
  const span = max - min || 1;
  const x = (i: number) => LEFT + (points.length < 2 ? w / 2 : (i * w) / (points.length - 1));
  const y = (v: number) => TOP + h - ((v - min) / span) * h;

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" width="${CHART_WIDTH}" height="${CHART_HEIGHT}" role="img" aria-label="${escapeXml(clamp(title, 120))}" class="chart" preserveAspectRatio="xMidYMid meet" font-size="11" font-family="inherit" fill="currentColor">`,
    `<title>${escapeXml(clamp(title, 120))}</title>`,
  ];
  for (const t of [0, 0.5, 1]) {
    const v = min + span * t;
    const gy = y(v);
    out.push(
      `<line x1="${LEFT}" x2="${CHART_WIDTH - RIGHT}" y1="${num(gy)}" y2="${num(gy)}" stroke="currentColor" stroke-opacity="0.2"/>`,
      `<text x="${LEFT - 6}" y="${num(gy + 4)}" text-anchor="end">${escapeXml(formatValue(v))}</text>`,
    );
  }
  if (points.length === 0) {
    out.push(`<text x="${CHART_WIDTH / 2}" y="${CHART_HEIGHT / 2}" text-anchor="middle">No points</text></svg>`);
    return out.join("");
  }
  const step = Math.max(1, Math.ceil(points.length / X_TICKS));
  points.forEach((p, i) => {
    if (i % step !== 0) return;
    out.push(
      `<text x="${num(x(i))}" y="${CHART_HEIGHT - 16}" text-anchor="middle">${escapeXml(clamp(p.label))}</text>`,
    );
  });
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${num(x(i))} ${num(y(p.value))}`).join(" ");
  out.push(`<path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>`);
  points.forEach((p, i) => {
    const dot = `<circle cx="${num(x(i))}" cy="${num(y(p.value))}" r="4"><title>${escapeXml(clamp(p.label, 40))}: ${escapeXml(formatValue(p.value))}</title></circle>`;
    out.push(p.href === undefined ? dot : `<a href="${escapeXml(p.href)}">${dot}</a>`);
  });
  out.push("</svg>");
  return out.join("");
}
