/**
 * The layout rules of the design check (#12017): z-index, spacing and boxes that
 * escape the page are tokens or the overlay host's, never a literal in a stylesheet.
 * Read from every `/* css *\/` template in src/web. Plain data in, plain data out:
 * `layoutIn` takes one file's text and a path; `scanLayout` the tree.
 *
 *   zindex    a `z-index` that is not `var(--z-…)` (or 0, auto): stacking order is a token
 *   fixed     `position: fixed`, outside src/web/overlay_host.ts: a layer opens through
 *             forgeOverlay
 *   viewport  a box sized 100vw, 100vh, 100dvh or 100svh (not inside calc/min/max/clamp,
 *             where it is a bound): a full-viewport box is an overlay, the host's to open
 *   space     a padding, margin or gap in px off the scale `2 4 6 8 12 16 24 32 48 64`:
 *             spacing is the scale
 *
 * Like the other rules this is a ratchet: `layout` in docs/design/baseline.json
 * names today's debt per file, and a pull may lower it, never raise it.
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { cssBlocksAt, sourceFiles } from "./overlay.ts";

export type LayoutRule = "zindex" | "fixed" | "viewport" | "space";
export const LAYOUT_RULES: readonly LayoutRule[] = ["zindex", "fixed", "viewport", "space"];
export type LayoutFinding = { line: number; rule: LayoutRule; text: string };
export type LayoutDebt = Record<string, Partial<Record<LayoutRule, number>>>;

export const OVERLAY_HOST = "src/web/overlay_host.ts";
export const SPACE_SCALE: readonly number[] = [0, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64];

/** One line each: the rule and the fix. */
export const LAYOUT_FIX: Record<LayoutRule, string> = {
  zindex: "stacking order is a token: z-index: var(--z-…), or open a layer through forgeOverlay",
  fixed: "position: fixed belongs to src/web/overlay_host.ts: open the layer with forgeOverlay.open",
  viewport: "a full-viewport box is an overlay: open it with forgeOverlay.open, or size it with a bound (min(), max())",
  space: `spacing is the scale ${SPACE_SCALE.slice(1).join(" ")}px: pick the nearest`,
};

const lineOf = (text: string, at: number) => text.slice(0, at).split("\n").length;

/** Whether `value` has a px length off the scale, outside a var() fallback. */
function offScale(value: string): boolean {
  const bare = value.replace(/var\([^)]*\)/g, "");
  for (const m of bare.matchAll(/(?<![\w.])(-?[0-9]*\.?[0-9]+)px\b/g)) {
    if (!SPACE_SCALE.includes(Math.abs(Number(m[1])))) return true;
  }
  return false;
}

export function layoutIn(text: string, path: string): LayoutFinding[] {
  const out: LayoutFinding[] = [];
  const host = relative("", path).replace(/\\/g, "/").endsWith(OVERLAY_HOST);
  for (const { css, at } of cssBlocksAt(text)) {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
    for (const m of code.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/gi)) {
      const prop = m[1]!.toLowerCase();
      const value = m[2]!.trim();
      const line = lineOf(text, at + m.index!);
      const add = (rule: LayoutRule) => out.push({ line, rule, text: `${prop}: ${value}` });
      if (prop === "z-index" && !/^(var\(\s*--z-[\w-]+\s*\)|0|auto)$/.test(value)) add("zindex");
      else if (prop === "position" && value === "fixed" && !host) add("fixed");
      else if (/^(width|height|min-width|min-height|inline-size|block-size)$/.test(prop) && /^(100(vw|vh|dvh|svh|lvh)|var\(--vv-h[^)]*\))$/.test(value) && !host) add("viewport");
      else if (/^(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$/.test(prop) && offScale(value)) add("space");
    }
  }
  return out;
}

export function scanLayout(root: string): Record<string, LayoutFinding[]> {
  const files: Record<string, LayoutFinding[]> = {};
  for (const f of sourceFiles(root)) {
    const found = layoutIn(readFileSync(f, "utf8"), relative(root, f));
    if (found.length) files[relative(root, f)] = found;
  }
  return files;
}

export function layoutCounts(files: Record<string, LayoutFinding[]>): LayoutDebt {
  const out: LayoutDebt = {};
  for (const [file, found] of Object.entries(files)) {
    for (const r of LAYOUT_RULES) {
      const n = found.filter((f) => f.rule === r).length;
      if (n) (out[file] ??= {})[r] = n;
    }
  }
  return out;
}

/** What a pull made worse, one line each: file:line, the rule and the fix. */
export function compareLayout(debt: LayoutDebt, files: Record<string, LayoutFinding[]>): string[] {
  const out: string[] = [];
  for (const [file, found] of Object.entries(files)) {
    for (const r of LAYOUT_RULES) {
      const here = found.filter((f) => f.rule === r);
      if (here.length <= (debt[file]?.[r] ?? 0)) continue;
      for (const f of here) out.push(`${file}:${f.line}  ${r}: ${f.text}  →  ${LAYOUT_FIX[r]} (${debt[file]?.[r] ?? 0} already named in docs/design/baseline.json)`);
    }
  }
  return out;
}
