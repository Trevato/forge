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
 *   class   a class defined in a `/* css *\/` template that DESIGN.md §5 does
 *           not name — a new component is named there first (#2700). §5d
 *           registers the page-local classes that predate the rule; a name
 *           it keeps after its last rule is gone fails too, so it only shrinks
 *
 * Known gaps, so nobody mistakes the gate for more than it is: colours built
 * in JS strings other than the forms above, `oklch()`,
 * `lab()` and system colours are not seen; sizes in `rem`/`em` are not
 * counted. Stricter patterns belong here, with a baseline update.
 *
 * The theme palettes (`src/design/themes.ts`) are where colours live and are
 * not scanned. Plain data in, plain data out: `scan` takes files, `compare`
 * takes the baseline, a scan and the text of DESIGN.md.
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
export type Baseline = { files: Record<string, Counts> };
export type Scan = Baseline & { classes: string[] };

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

/**
 * The text without its comments, so an issue reference (`#599`) is not read
 * as a three-digit hex. A line comment starts a line or follows whitespace,
 * which keeps `https://` in a string.
 */
export function uncommented(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

export function countFile(text: string): Counts {
  const code = uncommented(text);
  const mixes = (code.match(/color-mix\([^;{}]*\)/g) ?? []).filter((m) => !m.includes("var(")).length;
  const colour =
    (code.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-zA-Z_-])/g) ?? []).length +
    (code.match(/\b(?:rgba?|hsla?)\(/g) ?? []).length +
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

/** The section of DESIGN.md from the heading starting `## <n>.` to the next `## `. */
function section(design: string, n: string): string {
  const start = design.search(new RegExp(`^## ${n.replace(".", "\\.")}`, "m"));
  if (start < 0) return "";
  const end = design.slice(start + 1).search(/^## /m);
  return end < 0 ? design.slice(start) : design.slice(start, start + 1 + end);
}

/** The classes a stretch of DESIGN.md names: a selector's `.name` chain inside
 * a code span (which, as in Markdown, may wrap a line but not a paragraph),
 * bare or after an element (`pre.run-log`). A dotted word that is not a
 * selector — `ui.ts`, `codeberg.org`, `status.reviews` — names nothing. */
const SELECTOR = /(?<![\w/.$-])(?:(?:a|button|details|div|fieldset|form|input|label|li|ol|pre|section|select|span|table|textarea|ul)(?=\.))?((?:\.[a-z][a-z0-9_-]*)+)/gi;

function namedIn(text: string): string[] {
  const set = new Set<string>();
  for (const span of text.matchAll(/`((?:[^`\n]|\n(?!\n))+)`/g)) {
    for (const chain of span[1]!.matchAll(SELECTOR)) {
      for (const c of chain[1]!.split(".").slice(1)) set.add(c);
    }
  }
  return [...set].sort();
}

/** Every class DESIGN.md §5 names, its subsections and the §5d register included. */
export function documentedClasses(design: string): string[] {
  return namedIn(section(design, "5."));
}

/** The §5d register alone: the page-local classes that predate the rule. */
export function registeredClasses(design: string): string[] {
  const s5 = section(design, "5.");
  const start = s5.search(/^### 5d\./m);
  if (start < 0) return [];
  const end = s5.slice(start).search(/\n##+ /);
  return namedIn(end < 0 ? s5.slice(start) : s5.slice(start, start + end));
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
export function compare(base: Baseline, now: Scan, design: string): string[] {
  const out: string[] = [];
  for (const [file, c] of Object.entries(now.files)) {
    const b = base.files[file] ?? { colour: 0, size: 0 };
    if (c.colour > b.colour) out.push(`${file}: ${c.colour - b.colour} new colour literal(s) — use a token from themes.ts (var(--…))`);
    if (c.size > b.size) out.push(`${file}: ${c.size - b.size} new off-scale font-size — the scale is ${TYPE_SCALE.join(", ")}px`);
  }
  const named = new Set(documentedClasses(design));
  for (const k of now.classes) {
    if (!named.has(k)) out.push(`.${k}: a component class the design system does not have — use one docs/DESIGN.md §5 names, or name it there first`);
  }
  const defined = new Set(now.classes);
  for (const k of registeredClasses(design)) {
    if (!defined.has(k)) out.push(`.${k}: no stylesheet defines it any more — strike it from docs/DESIGN.md §5d`);
  }
  return out;
}

const BASELINE = "docs/design/baseline.json";
const DESIGN = "docs/DESIGN.md";

if (import.meta.main) {
  const root = process.cwd();
  const now = scan(root);
  if (process.argv.includes("--update")) {
    const baseline: Baseline = { files: now.files };
    writeFileSync(join(root, BASELINE), JSON.stringify(baseline, null, 2) + "\n");
    console.log(`wrote ${BASELINE}`);
  } else {
    const base: Baseline = JSON.parse(readFileSync(join(root, BASELINE), "utf8"));
    const problems = compare(base, now, readFileSync(join(root, DESIGN), "utf8"));
    for (const p of problems) console.error(p);
    if (problems.length) process.exit(1);
    console.log("design: no colour, size or component added outside the system");
  }
}
