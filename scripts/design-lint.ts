/**
 * The design check (#2678): a pull may not add a colour, a font size or a
 * component class the design system (`docs/DESIGN.md`) does not already have.
 *
 * The system is not new; the pages drifted from it. So this is a ratchet, not
 * a purge: `docs/design/baseline.json` records what the drift is today, per
 * file, and a pull fails when it goes up. Paying a debt down is always allowed
 * (and `bun scripts/design-lint.ts --update` writes the lower number down).
 *
 *   colour  a hex, rgb(), hsl() or named-colour literal, or a color-mix() that
 *           mixes no `var(--token)`, in src/web — a colour is a token
 *   size    a font-size in px off the type scale (§3)
 *   class   a class defined in a `/* css *\/` template that the baseline does
 *           not know — a new component must be named in DESIGN.md first
 *
 * Known gaps, so nobody mistakes the gate for more than it is: the class rule
 * checks the baseline, not DESIGN.md §5 (619 classes are grandfathered until
 * #2700); colours built in JS strings other than the forms above, `oklch()`,
 * `lab()` and system colours are not seen; sizes in `rem`/`em` are not
 * counted. Stricter patterns belong here, with a baseline update.
 *
 * The theme palettes (`src/design/themes.ts`) are where colours live and are
 * not scanned. Plain data in, plain data out: `scan` takes files, `compare`
 * takes two scans.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/** The type scale in docs/DESIGN.md §3, in px. */
export const TYPE_SCALE: readonly number[] = [11.5, 12.5, 13, 14, 15, 16, 20];

const NAMED = [
  "black", "white", "red", "green", "blue", "yellow", "orange", "purple", "pink",
  "gray", "grey", "silver", "gold", "navy", "teal", "cyan", "magenta", "maroon",
  "olive", "lime", "aqua", "fuchsia", "brown", "crimson", "coral", "indigo", "violet",
];
const NAMED_RE = new RegExp(
  `(?:color|background(?:-color)?|border(?:-[a-z]+)*|fill|stroke|outline(?:-color)?)\\s*:[^;{}]*\\b(?:${NAMED.join("|")})\\b`,
  "gi",
);

export type Counts = { colour: number; size: number };
export type Scan = {
  files: Record<string, Counts>;
  classes: string[];
};

const SKIP = /(^|\/)(og\/vendor)\//;

export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !SKIP.test(p)) out.push(p);
    }
  };
  walk(join(root, "src/web"));
  return out.sort();
}

/** The CSS inside `/* css *\/ \`…\`` templates — the only place a class is defined. */
function cssBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /\/\* css \*\/\s*`((?:[^`\\]|\\.)*)`/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1]!);
  return out;
}

export function countFile(text: string): Counts {
  const mixes = (text.match(/color-mix\([^;{}]*\)/g) ?? []).filter((m) => !m.includes("var(")).length;
  const colour =
    (text.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-zA-Z_-])/g) ?? []).length +
    (text.match(/\b(?:rgba?|hsla?)\(/g) ?? []).length +
    cssBlocks(text).reduce((n, css) => n + (css.match(NAMED_RE) ?? []).length, 0) +
    mixes;
  let size = 0;
  for (const m of text.matchAll(/font-size:\s*([0-9.]+)px/g)) {
    if (!TYPE_SCALE.includes(Number(m[1]))) size++;
  }
  return { colour, size };
}

export function classesIn(text: string): string[] {
  const set = new Set<string>();
  for (const css of cssBlocks(text)) {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    // Selectors only: what precedes a `{`, minus declarations.
    for (const sel of bare.matchAll(/([^{};]+)\{/g)) {
      for (const c of sel[1]!.matchAll(/(?:^|[\s,>+~(\]:)])\.([a-z][a-z0-9_-]*)/gi)) set.add(c[1]!);
    }
  }
  return [...set];
}

export function scan(root: string): Scan {
  const files: Record<string, Counts> = {};
  const classes = new Set<string>();
  for (const f of sourceFiles(root)) {
    const text = readFileSync(f, "utf8");
    const c = countFile(text);
    if (c.colour || c.size) files[relative(root, f)] = c;
    for (const k of classesIn(text)) classes.add(k);
  }
  return { files, classes: [...classes].sort() };
}

/** What a pull made worse, one line each. Empty means the check passes. */
export function compare(base: Scan, now: Scan): string[] {
  const out: string[] = [];
  for (const [file, c] of Object.entries(now.files)) {
    const b = base.files[file] ?? { colour: 0, size: 0 };
    if (c.colour > b.colour) out.push(`${file}: ${c.colour - b.colour} new colour literal(s) — use a token from themes.ts (var(--…))`);
    if (c.size > b.size) out.push(`${file}: ${c.size - b.size} new off-scale font-size — the scale is ${TYPE_SCALE.join(", ")}px`);
  }
  const known = new Set(base.classes);
  for (const k of now.classes) {
    if (!known.has(k)) out.push(`.${k}: a component class the design system does not have — name it in docs/DESIGN.md §5, then run --update`);
  }
  return out;
}

const BASELINE = "docs/design/baseline.json";

if (import.meta.main) {
  const root = process.cwd();
  const now = scan(root);
  if (process.argv.includes("--update")) {
    writeFileSync(join(root, BASELINE), JSON.stringify(now, null, 2) + "\n");
    console.log(`wrote ${BASELINE}`);
  } else {
    const problems = compare(JSON.parse(readFileSync(join(root, BASELINE), "utf8")), now);
    for (const p of problems) console.error(p);
    if (problems.length) process.exit(1);
    console.log("design: no colour, size or component added outside the system");
  }
}
