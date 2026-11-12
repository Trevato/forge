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
 * Five more counts hold the website specification's stylesheet rules
 * (#2939, specification.website, the same ratchet: today's count is the
 * ceiling). Each is counted per `/* css *\/` template (`webCss`):
 *
 *   motion   an animation/transition/@keyframes in a block with no
 *            `prefers-reduced-motion` (specification.website, motion)
 *   forced   a block that styles `:focus` and has no `forced-colors: active`
 *            (specification.website, forced colours)
 *   focus    a `:focus` selector that is not `:focus-visible`/`:focus-within`
 *            (specification.website, focus)
 *   input    an input, select or textarea under 16px, which zooms iOS
 *            (specification.website, input size)
 *   target   a button, link, input or select under 24px wide or high, WCAG 2.5.8
 *            (specification.website, target size)
 *
 * The quiet-page rules (#8775, #8719) are held per file in `docs/design/quiet-debt.json`,
 * the same ratchet, and may only go down: `label` ("Status: Open"), `caps`
 * (`text-transform: uppercase`), `echo` (an icon's aria-label equal to its visible
 * text), `inline-colour` (a colour name in a `style=""`) and `accent` (a second
 * accent token such as `--accent-2`; only `--accent` and `--accent-fg` exist).
 * They match markup and style, never a paragraph's words. Named in docs/design/areas/quiet.md.
 *
 * `stranger` (#11458) names each word of `STRANGER_NEVER_SEES` that a stranger-path page says; see `strangerWords()`.
 *
 * `banner` (#10699) refuses a standing alert in the home and board builders; see `banner()`.
 *
 * A red names the file:line, the literal and what to use instead, so one pass
 * fixes it; run `bun scripts/design-lint.ts` before pushing. A new class is named
 * in its own `docs/design/areas/<area>.md` rather than in DESIGN.md, which
 * every pull would otherwise edit (#4063). DESIGN.md itself is a spine that
 * links one file per section under `docs/design/sections/` (#5937); `designText`
 * reads the spine and those files in its order, so the § numbers mean what
 * they did when it was one file.
 *
 * Known gaps, so nobody mistakes the gate for more than it is: colours built
 * in JS strings other than the forms above, `oklch()`,
 * `lab()` and system colours are not seen; sizes in `rem`/`em` are not
 * counted. Stricter patterns belong here, with a baseline update.
 *
 * The theme palettes (`src/design/themes.ts`) are where colours live and are
 * not scanned. Plain data in, plain data out: `scan` takes files, `compare`
 * takes the baseline, a scan and the text of DESIGN.md with its sections.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { STRANGER_NEVER_SEES } from "../src/design/first_five_minutes.ts";

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

export type Counts = { colour: number; size: number } & Partial<WebCounts>;
export type WebCounts = { motion: number; forced: number; focus: number; input: number; target: number };
const WEB_KEYS = ["motion", "forced", "focus", "input", "target"] as const;
const WEB_MESSAGE: Record<(typeof WEB_KEYS)[number], string> = {
  motion: "animation without a prefers-reduced-motion guard (specification.website, motion)",
  forced: "custom focus styling without @media (forced-colors: active) (specification.website, forced colours)",
  focus: ":focus styled without :focus-visible (specification.website, focus)",
  input: "form input under 16px, which zooms iOS (specification.website, input size)",
  target: "interactive target under 24x24 CSS px, WCAG 2.5.8 (specification.website, target size)",
};
export type Baseline = { files: Record<string, Counts> };
/** One offence, where it is and what the system offers instead. */
export type Finding = { line: number; kind: "colour" | "size"; text: string; use: string };
export type Scan = Baseline & { classes: string[]; found?: Record<string, Finding[]> };

const SKIP = /(^|\/)(og\/vendor|web\/vendor)\//;

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
  return cssBlocksAt(text).map((b) => b.css);
}

/** The same blocks with the offset in `text` where each one's css starts. */
function cssBlocksAt(text: string): { css: string; at: number }[] {
  const out: { css: string; at: number }[] = [];
  const re = /\/\* css \*\/\s*`((?:[^`\\]|\\.)*)`/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ css: m[1]!, at: m.index + m[0].length - 1 - m[1]!.length });
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

/** Comments blanked but newlines kept, so an offset still maps to its line. */
const blanked = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|\s)\/\/.*$/gm, (_m, a) => a);

/** The token a colour literal on this line should be, from the property it sits in. */
function tokenFor(line: string): string {
  if (/\b(?:border|outline)[-\w]*\s*:/.test(line)) return "var(--border) (a hairline) or var(--border-strong)";
  if (/\bbackground[-\w]*\s*:/.test(line)) return "var(--card) (raised), var(--muted) (recessed) or var(--bg)";
  if (/\b(?:fill|stroke)\s*:/.test(line)) return "var(--fg), var(--muted-fg) or a status token";
  if (/\bcolor\s*:/.test(line)) return "var(--fg), var(--muted-fg) or a status token (--success, --danger, --attn)";
  return "a token from docs/DESIGN.md §2 (var(--…))";
}

/** Where `countFile` counts colours and off-scale sizes: file line, the literal, the system's answer. */
export function locate(text: string): Finding[] {
  const code = blanked(text);
  const lines = code.split("\n");
  const out: Finding[] = [];
  const colour = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-zA-Z_-])|\b(?:rgba?|hsla?)\([^)]*\)/g;
  lines.forEach((l, i) => {
    for (const m of l.matchAll(colour)) out.push({ line: i + 1, kind: "colour", text: m[0], use: tokenFor(l) });
    for (const m of l.matchAll(/font-size:\s*([0-9.]+)px/g)) {
      const px = Number(m[1]);
      if (TYPE_SCALE.includes(px)) continue;
      const near = TYPE_SCALE.reduce((a, b) => (Math.abs(b - px) < Math.abs(a - px) ? b : a));
      out.push({ line: i + 1, kind: "size", text: `font-size: ${m[1]}px`, use: `${near}px (the scale is ${TYPE_SCALE.join(", ")}px, §3)` });
    }
  });
  for (const { css, at: start } of cssBlocksAt(text)) {
    for (const m of css.matchAll(NAMED_RE)) {
      const line = text.slice(0, start + m.index!).split("\n").length;
      out.push({ line, kind: "colour", text: m[0].trim(), use: tokenFor(m[0]) });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

const INTERACTIVE = /(^|[\s,>+~])(a|button|input|select|summary)\b|\.btn\b|\[role=["']?button/i;
const FIELD = /(^|[\s,>+~])(input|select|textarea)\b/i;

/** The five specification.website stylesheet counts for one file's css templates. */
export function webCss(text: string): WebCounts {
  const n: WebCounts = { motion: 0, forced: 0, focus: 0, input: 0, target: 0 };
  for (const css of cssBlocks(text)) {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    if (!/prefers-reduced-motion/.test(bare)) n.motion += (bare.match(/(?<![\w-])(?:animation|transition)(?:-name)?\s*:|@keyframes\b/g) ?? []).length;
    if (/:focus(?!-visible|-within)|:focus-visible/.test(bare) && !/forced-colors/.test(bare)) n.forced++;
    n.focus += (bare.match(/:focus(?![-\w])/g) ?? []).length;
    for (const r of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = r[1]!, body = r[2]!;
      if (FIELD.test(sel)) {
        for (const f of body.matchAll(/font-size:\s*([0-9.]+)px/g)) if (Number(f[1]) < 16) n.input++;
      }
      if (INTERACTIVE.test(sel)) {
        for (const d of body.matchAll(/(?<![\w-])(?:min-)?(?:width|height)\s*:\s*([0-9.]+)px/g)) if (Number(d[1]) < 24) n.target++;
      }
    }
  }
  return n;
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
export function documentedClasses(design: string, areas: readonly string[] = []): string[] {
  return [...new Set([...namedIn(section(design, "5.")), ...areas.flatMap(namedIn)])].sort();
}

/** The section files the spine links, in its order: `](design/sections/<file>.md)`. */
export function sectionLinks(spine: string): string[] {
  return [...spine.matchAll(/\]\(design\/sections\/([a-z0-9-]+\.md)\)/g)].map((m) => m[1]!);
}

/** DESIGN.md as one text: the spine, then each section it links, in order (#5937). */
export function designText(root: string): string {
  const spine = readFileSync(join(root, DESIGN), "utf8");
  return [spine, ...sectionLinks(spine).map((f) => readFileSync(join(root, SECTIONS, f), "utf8"))].join("\n");
}

/** The area files under docs/design/areas/: each is wholly vocabulary, one file per component area (#4063). */
export function areaFiles(root: string): string[] {
  try {
    return readdirSync(join(root, AREAS)).filter((n) => n.endsWith(".md") && n !== "README.md").sort().map((n) => readFileSync(join(root, AREAS, n), "utf8"));
  } catch {
    return [];
  }
}

/** A documented class that shares a word with the new one, or none: the nearest thing to reuse. */
function similar(k: string, named: readonly string[]): string {
  const words = k.split("-").filter((w) => w.length > 2);
  const hit = named.filter((n) => n !== k && n.split("-").some((w) => words.includes(w))).slice(0, 3);
  return hit.length ? ` (already named and alike: ${hit.map((h) => "." + h).join(" ")})` : "";
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
  const found: Record<string, Finding[]> = {};
  const classes = new Set<string>();
  for (const f of sourceFiles(root)) {
    const text = readFileSync(f, "utf8");
    const c: Counts = { ...countFile(text), ...webCss(text) };
    if (c.colour || c.size || WEB_KEYS.some((k) => c[k])) files[relative(root, f)] = c;
    if (c.colour || c.size) found[relative(root, f)] = locate(text);
    for (const k of classesIn(text)) classes.add(k);
  }
  return { files, classes: [...classes].sort(), found };
}

/** What a pull made worse, one line each. Empty means the check passes. */
export function compare(base: Baseline, now: Scan, design: string, areas: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const [file, c] of Object.entries(now.files)) {
    const b = base.files[file] ?? { colour: 0, size: 0 };
    for (const k of WEB_KEYS) {
      if ((c[k] ?? 0) > (b[k] ?? 0)) out.push(`${file}: ${(c[k] ?? 0) - (b[k] ?? 0)} new ${WEB_MESSAGE[k]}`);
    }
    const where = (kind: Finding["kind"]) =>
      (now.found?.[file] ?? []).filter((f) => f.kind === kind).map((f) => `\n  ${file}:${f.line}  ${f.text}  →  use ${f.use}`).join("");
    if (c.colour > b.colour) out.push(`${file}: ${c.colour - b.colour} new colour literal(s) — a colour is a token, not a literal (${b.colour} already there are the baseline; the new one is among these):${where("colour") || " use var(--…) from docs/DESIGN.md §2"}`);
    if (c.size > b.size) out.push(`${file}: ${c.size - b.size} new off-scale font-size — the scale is ${TYPE_SCALE.join(", ")}px:${where("size") || " pick the nearest"}`);
  }
  const all = documentedClasses(design, areas);
  const named = new Set(all);
  for (const k of now.classes) {
    if (!named.has(k)) out.push(`.${k}: a component class the design system does not have${similar(k, all)} — use one docs/DESIGN.md §5 names, or name it in a code span in your own file docs/design/areas/<area>.md (not DESIGN.md, so parallel pulls never conflict)`);
  }
  const defined = new Set(now.classes);
  for (const k of registeredClasses(design)) {
    if (!defined.has(k)) out.push(`.${k}: no stylesheet defines it any more — strike it from §5d, docs/design/sections/5d-page-local-classes.md`);
  }
  return out;
}

/** The quiet-page rules a machine can check (#8775, from #8719): markup and style only, never prose. */
export type QuietRule = "label" | "caps" | "echo" | "inline-colour" | "keyhint" | "accent";
export type QuietFinding = { line: number; rule: QuietRule; text: string; use: string };
export const QUIET_RULES: readonly QuietRule[] = ["label", "caps", "echo", "inline-colour", "keyhint", "accent"];
const STATUS_WORD = "open|closed|merged|draft|done|failed|passing|failing|pending|running|queued|shipped|blocked|active|ready";

/** Where `text` breaks a quiet-page rule: file line, the offence, and what to use instead. */
export function quiet(text: string): QuietFinding[] {
  const code = blanked(text);
  const at = (i: number) => code.slice(0, i).split("\n").length;
  const out: QuietFinding[] = [];
  // "Status: Open": a label tag ending in a colon, straight before a status word, a tag or an interpolation.
  for (const m of code.matchAll(new RegExp(`>\\s*(?:Status|State)\\s*:\\s*(?=<|\\$\\{|(?:${STATUS_WORD})\\b)`, "gi"))) {
    out.push({ line: at(m.index!), rule: "label", text: m[0].slice(1).trim(), use: "the status glyph and colour alone, its word in title/aria-label and on the detail page (§6a)" });
  }
  for (const { css, at: start } of cssBlocksAt(text)) {
    for (const m of css.matchAll(/text-transform\s*:\s*uppercase/gi)) {
      out.push({ line: at(start + m.index!), rule: "caps", text: m[0], use: "size and weight for hierarchy; drop the uppercase caption" });
    }
  }
  // An icon beside its own label: the aria-label and the visible text are the same words.
  for (const m of code.matchAll(/<(button|a)\b[^>]*\baria-label="([^"$]+)"[^>]*>([\s\S]*?)<\/\1>/g)) {
    const visible = m[3]!.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    if (/<svg\b/.test(m[3]!) && visible.toLowerCase() === m[2]!.trim().toLowerCase()) {
      out.push({ line: at(m.index!), rule: "echo", text: `aria-label="${m[2]}" beside the visible "${visible}"`, use: "either the icon with the aria-label, or the visible word with the icon aria-hidden — never both" });
    }
  }
  // A key hint takes no room at rest (#8930): inline only in a menu item, else `hintAttr`.
  for (const m of code.matchAll(/(?<!function )\bkeyHint\(|<kbd class="keyhint"/g)) {
    if (!inMenuItem(code, m.index!) && !code.slice(Math.max(0, m.index! - 60), m.index!).includes("function keyHint")) {
      out.push({ line: at(m.index!), rule: "keyhint", text: m[0], use: "hintAttr(key): a tooltip on hover and an overlay on request; an inline hint only inside a menu item" });
    }
  }
  // At most one accent (docs/DESIGN.md, principles): `--accent` and `--accent-fg` exist; a second is a second voice.
  for (const m of code.matchAll(/--accent(?!-fg\b)(?:[-_][a-z0-9_-]*|\d+)(?![\w-])/gi)) {
    out.push({ line: at(m.index!), rule: "accent", text: m[0], use: "var(--accent) for interaction alone, and var(--fg) or var(--muted-fg) for emphasis; one accent per page" });
  }
  // A colour name in an inline style="": the stylesheet scan reads css templates only.
  for (const m of code.matchAll(/\bstyle="([^"]*)"/g)) {
    const bad = m[1]!.match(NAMED_RE);
    if (bad) out.push({ line: at(m.index!), rule: "inline-colour", text: bad[0].trim(), use: tokenFor(bad[0]) });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** Is the position inside a still-open menu or palette row? The nearest earlier
 * element whose class is `menu-item`/`palette-item`, not yet closed before here. */
export function inMenuItem(code: string, at: number): boolean {
  const before = code.slice(0, at);
  const opens = [...before.matchAll(/<(a|button|div|li)\b[^>]*?\bclass="[^"]*\b(?:menu-item|palette-item)\b/g)];
  const last = opens.at(-1);
  if (!last) return false;
  const rest = before.slice(last.index!);
  const tag = last[1]!;
  const depth = (rest.match(new RegExp(`<${tag}\\b`, "g")) ?? []).length - (rest.match(new RegExp(`</${tag}\\s*>`, "g")) ?? []).length;
  return depth > 0;
}

export const QUIET_DEBT = "docs/design/quiet-debt.json";
export type QuietDebt = Record<string, Partial<Record<QuietRule, number>>>;

/** Per file and rule, how many findings there are: the shape the debt list is kept in. */
export function quietCounts(files: Record<string, QuietFinding[]>): QuietDebt {
  const out: QuietDebt = {};
  for (const [f, list] of Object.entries(files)) {
    for (const x of list) (out[f] ??= {})[x.rule] = ((out[f] ??= {})[x.rule] ?? 0) + 1;
  }
  return out;
}

/** What broke a quiet rule beyond the debt, and a debt that has been paid and not struck. Empty passes. */
export function compareQuiet(debt: QuietDebt, files: Record<string, QuietFinding[]>): string[] {
  const out: string[] = [];
  const now = quietCounts(files);
  for (const f of new Set([...Object.keys(now), ...Object.keys(debt)])) {
    for (const r of QUIET_RULES) {
      const n = now[f]?.[r] ?? 0, d = debt[f]?.[r] ?? 0;
      if (n > d) {
        const where = (files[f] ?? []).filter((x) => x.rule === r).map((x) => `\n  ${f}:${x.line}  ${x.text}  →  use ${x.use}`).join("");
        out.push(`${f}: ${n - d} new quiet-page "${r}" finding(s) (${d} already there are debt in ${QUIET_DEBT}):${where}`);
      } else if (n < d) out.push(`${f}: the "${r}" debt is ${d} and only ${n} remain — lower it in ${QUIET_DEBT} (bun scripts/design-lint.ts --update)`);
    }
  }
  return out;
}

export function scanQuiet(root: string): Record<string, QuietFinding[]> {
  const out: Record<string, QuietFinding[]> = {};
  for (const f of sourceFiles(root)) {
    const found = quiet(readFileSync(f, "utf8"));
    if (found.length) out[relative(root, f)] = found;
  }
  return out;
}

/**
 * The calm rule (#10699): a healthy forge's home and board carry no standing
 * alert. `role="alert"`, a `.banner` or a `.notice-danger` in those builders is
 * refused; a setting that is off is one line on its own page, never a banner
 * over the board. The only opt-out is a transient flash: the same tag carries
 * `data-flash`. Zero is the ceiling, so there is no debt list.
 */
export const BANNER_FILES = /(^|\/)src\/web\/(pages\/(board|boards-view)\.ts|studio\/(home[\w-]*|alarm_lines)\.ts)$/;
export type BannerFinding = { line: number; text: string };
export function banner(text: string): BannerFinding[] {
  const code = blanked(text);
  const out: BannerFinding[] = [];
  for (const m of code.matchAll(/<[a-z][^<>]*?(?:\brole="alert"|\bclass="[^"]*\b(?:banner|notice-danger)\b[^"]*")[^<>]*>/gi)) {
    if (/\bdata-flash\b/.test(m[0])) continue;
    out.push({ line: code.slice(0, m.index!).split("\n").length, text: m[0].slice(0, 80) });
  }
  return out;
}
export function scanBanner(root: string): string[] {
  return sourceFiles(root)
    .filter((f) => BANNER_FILES.test(f))
    .flatMap((f) => banner(readFileSync(f, "utf8")).map((b) => `${relative(root, f)}:${b.line}  ${b.text}  →  a standing alert on home or the board: say it as one line on its own settings page and in the system page (a transient flash carries data-flash)`));
}

/**
 * Principle 7 (#11190): a fact is a `dl` row, not a card. A `card(` from
 * `src/web/ui.ts` whose body is one `<p>` or a bare line of text, with no list,
 * form or `dl`, is a box around a sentence (principle 6). Textual and narrow:
 * only a first argument that is an `html` template holding exactly that.
 * The same box drawn through `listCard([row({ title })])` — one row with no
 * link, lead, meta or trail — is refused too: a row is a thing you can open or
 * read facts off; a lone title is a sentence. A template with a nested backtick
 * (an `html` inside `${}`) is not examined: the scan reads the first argument
 * as flat text and passes what it cannot read.
 * `CARD_ALLOW` is the short list of pages that cannot change yet, one reason
 * each; it only shrinks.
 */
export const CARD_ALLOW: Record<string, string> = {};
export type CardFinding = { line: number; text: string };

/** The first argument of the call whose `(` is at `open`: up to the top-level comma or the close. */
function firstArg(code: string, open: number): string {
  let depth = 0, tpl = 0;
  for (let i = open + 1; i < code.length; i++) {
    const c = code[i]!;
    if (c === "\\") { i++; continue; }
    if (c === "`") { tpl = tpl ? 0 : 1; continue; }
    if (tpl) continue;
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") { if (depth-- === 0) return code.slice(open + 1, i); }
    else if (c === "," && depth === 0) return code.slice(open + 1, i);
  }
  return code.slice(open + 1);
}

export function loneSentenceCards(text: string): CardFinding[] {
  const code = blanked(text);
  const out: CardFinding[] = [];
  for (const m of code.matchAll(/(?<![\w.$])card\(/g)) {
    if (/function\s+$/.test(code.slice(Math.max(0, m.index! - 12), m.index!))) continue;
    const arg = firstArg(code, m.index! + m[0].length - 1).trim();
    const body = /^html`([^`]*)`$/.exec(arg)?.[1]?.trim();
    if (body === undefined || /<(?:ul|ol|dl|form|table|pre|h[1-6]|div|section|details)\b/i.test(body)) continue;
    const one = /^<p\b[^>]*>(?:(?!<p\b)[\s\S])*<\/p>$/i.test(body);
    const bare = !/</.test(body) && /[A-Za-z]{2}/.test(body.replace(/\$\{[^}]*\}/g, ""));
    if (one || bare) out.push({ line: code.slice(0, m.index!).split("\n").length, text: arg.replace(/\s+/g, " ").slice(0, 70) });
  }
  for (const m of code.matchAll(/(?<![\w.$])listCard\(/g)) {
    if (/function\s+$/.test(code.slice(Math.max(0, m.index! - 12), m.index!))) continue;
    const arg = firstArg(code, m.index! + m[0].length - 1).trim();
    const inner = /^\[\s*row\(\{([\s\S]*)\}\)\s*,?\s*\]$/.exec(arg)?.[1];
    if (inner === undefined || /(?<![\w.])row\(/.test(inner) || /(?:^|[{,])\s*(?:href|lead|meta|trail)\s*[:,}]/.test(inner.replace(/\s+/g, " ").replace(/^/, "{"))) continue;
    out.push({ line: code.slice(0, m.index!).split("\n").length, text: arg.replace(/\s+/g, " ").slice(0, 70) });
  }
  return out;
}
export function scanCards(root: string): string[] {
  return sourceFiles(root)
    .filter((f) => !(relative(root, f) in CARD_ALLOW))
    .flatMap((f) => loneSentenceCards(readFileSync(f, "utf8")).map((c) => `${relative(root, f)}:${c.line}  card(${c.text}…)  →  principle 7 (docs/DESIGN.md): a card (or a listCard of one bare row) around one sentence is a box around a thing; put the sentence directly under the page head, or make it a dl row`));
}

/**
 * The stranger's words (#11458): the screens a signed-out person passes from a
 * link to their forge show none of `STRANGER_NEVER_SEES`. Only visible text is
 * read: the words of a template or a sentence-like string, with tags (so
 * attributes), `${}` code, comments, CSS and scripts left out. "claim" stays a
 * fine route name and class; it is a refusal only where it is read.
 */
export const STRANGER_FILES = ["src/web/pages/claim.ts", "src/web/pages/start-forge.ts", "src/web/pages/new-forge.ts", "src/web/pages/forge-waiting.ts"];
const STRANGER_RE = new RegExp(`(?<![A-Za-z0-9_-])(?:${STRANGER_NEVER_SEES.join("|")})(?:s|ed|ing)?(?![A-Za-z0-9_-])`, "gi");
export type StrangerFinding = { line: number; word: string; text: string };

/** The strings of `code`: [start offset, raw text with `${}` holes blanked]; nested templates are their own strings. */
function stringsOf(code: string): { at: number; text: string; quote: string }[] {
  const out: { at: number; text: string; quote: string }[] = [];
  const template = (i: number): number => {
    let text = "";
    const at = i + 1;
    for (i++; i < code.length; i++) {
      const c = code[i]!;
      if (c === "\\") { text += "  "; i++; continue; }
      if (c === "`") break;
      if (c === "$" && code[i + 1] === "{") {
        let depth = 1;
        i += 2;
        text += "  ";
        for (; i < code.length && depth > 0; i++) {
          const d = code[i]!;
          if (d === "`") { i = template(i); text += " "; i--; continue; }
          if (d === '"' || d === "'") { const e = code.indexOf(d, i + 1); i = e < 0 ? code.length : e; text += " "; continue; }
          if (d === "{") depth++;
          else if (d === "}") depth--;
          if (d === "\n") text += "\n";
        }
        i--;
        continue;
      }
      text += c;
    }
    out.push({ at, text, quote: "`" });
    return i;
  };
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (c === "`") i = template(i);
    else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== c && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
      if (code[j] === c) out.push({ at: i + 1, text: code.slice(i + 1, j), quote: c });
      i = j;
    } else if (c === "/" && /[(,=:]\s*$/.test(code.slice(Math.max(0, i - 4), i)) && code[i + 1] !== "/") {
      const e = code.indexOf("\n", i); // a regex literal: skip to the line's end rather than read its quotes
      i = e < 0 ? code.length : e;
    }
  }
  return out;
}

export function strangerWords(text: string): StrangerFinding[] {
  const code = blanked(text);
  const out: StrangerFinding[] = [];
  for (const s of stringsOf(code)) {
    let t = s.text;
    if (s.quote === "`" && !/<[a-z]/i.test(t) && (!/\s/.test(t.trim()) || /^[\w./#:?&=@-]+\s*$/.test(t.trim()))) continue; // a key or a path, not a sentence
    if (s.quote === "`") {
      t = t.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, " ")).replace(/<[^<>]*>/g, (m) => m.replace(/[^\n]/g, " "));
      if (/[{};]\s*[\w.#:-]*\s*[{};]|[{;]\s*$/.test(t) && /[{}]/.test(t)) continue; // CSS
    } else if (!/\s/.test(t) || /^[\w./#:?&=@-]+$/.test(t)) continue; // an id, a path, a key: not a sentence
    for (const m of t.matchAll(STRANGER_RE)) {
      out.push({ line: code.slice(0, s.at).split("\n").length + t.slice(0, m.index!).split("\n").length - 1, word: m[0], text: t.slice(Math.max(0, m.index! - 20), m.index! + m[0].length + 20).replace(/\s+/g, " ").trim() });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}
export function scanStranger(root: string): string[] {
  return STRANGER_FILES.flatMap((f) => strangerWords(readFileSync(join(root, f), "utf8")).map((w) => `${f}:${w.line}  "${w.word}" in "${w.text}"  →  a stranger is never shown this word (docs/DESIGN.md § The first five minutes): say it in plain words`));
}

/**
 * `overlay` (#11831): a rule that sets `display` (other than `none`), `visibility: visible`, or `opacity` above 0
 * with `position: fixed` on a selector that can match a closed `<dialog>`, a `[popover]` or a `[hidden]` element
 * draws it over the page: the browser hides a closed one with `dialog:not([open]) { display: none }`, and a bare
 * selector's `display` beats that. 0.7.549 put a black panel over every phone page this way. The selector must
 * itself require the open state. Read across every media query in every `/* css *\/` template.
 */
export type OverlayFinding = { line: number; selector: string; decl: string };
const OVERLAY_CLASSES = ["dialog", "palette", "sheet", "drawer", "toast", "popover", "modal", "overlay", "backdrop", "finder"];
const OPEN_STATE = /\[open\]|:popover-open|:modal|:not\(\s*\[hidden\]\s*\)|:not\(\s*:popover-open\s*\)/;

/** Whether the selector's last compound can be a closed overlay and nothing in it asks for the open state. */
export function matchesClosedOverlay(selector: string, extra: readonly string[] = []): boolean {
  const last = selector.trim().split(/[\s>+~]+/).filter(Boolean).pop() ?? "";
  if (OPEN_STATE.test(last)) return false; // the last compound only: `.x[open] .toast` can still be closed
  if (/^dialog\b|\[popover\b|\[hidden\b/.test(last)) return true;
  const classes = [...last.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!);
  return classes.some((c) => OVERLAY_CLASSES.includes(c) || extra.includes(c));
}

/** Every class a `<dialog>` or `[popover]` element carries in the source: an overlay is found by its markup, not only by name. */
export function overlayClassesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/<dialog\b[^>]*?\bclass="([^"$]*)"|<[a-z]+\b[^>]*?\bpopover\b[^>]*?\bclass="([^"$]*)"/g)) for (const c of (m[1] ?? m[2] ?? "").split(/\s+/)) if (c) out.add(c);
  return [...out];
}

export function overlay(text: string, extra: readonly string[] = []): OverlayFinding[] {
  const out: OverlayFinding[] = [];
  for (const { css, at } of cssBlocksAt(text)) {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\\`/g, " `").replace(/\$\{[^{}]*\}/g, (m) => " ".repeat(m.length)); // a `${x}` is blanked, so it cannot break the scan
    // Every `{ declarations }` with no nested `{`; an at-rule's own braces never hold declarations directly.
    for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const head = m[1]!.trim().split(/[;}]/).pop()!.trim();
      if (!head || head.startsWith("@")) continue;
      const body = m[2]!;
      const decls = [...body.matchAll(/([a-z-]+)\s*:\s*([^;]+)/g)].map((d) => [d[1]!, d[2]!.trim().replace(/\s*!important$/, "")] as const);
      const get = (k: string) => decls.find((d) => d[0] === k)?.[1];
      const display = get("display");
      let bad = "";
      if (display !== undefined && display !== "none") bad = `display: ${display}`;
      else if (get("visibility") === "visible") bad = "visibility: visible";
      else if (get("position") === "fixed" && get("opacity") !== undefined && Number(get("opacity")) > 0) bad = `opacity: ${get("opacity")} with position: fixed`;
      if (!bad) continue;
      const line = text.slice(0, at + m.index!).split("\n").length;
      for (const sel of head.split(",").map((x) => x.trim())) if (matchesClosedOverlay(sel, extra)) out.push({ line, selector: sel, decl: bad });
    }
  }
  return out;
}

export function scanOverlay(root: string): string[] {
  const files = sourceFiles(root);
  const extra = [...new Set(files.flatMap((f) => overlayClassesIn(readFileSync(f, "utf8"))))];
  return files.flatMap((f) =>
    overlay(readFileSync(f, "utf8"), extra).map((o) => `${relative(root, f)}:${o.line}  ${o.selector} { ${o.decl} }  →  this selector can match a closed dialog, popover or [hidden] element and would draw it over the page: write ${o.selector}[open] (or :popover-open, :not([hidden])), or move the layout into the shared open-state rule (docs/DESIGN.md, overlays)`));
}

const BASELINE = "docs/design/baseline.json";
const DESIGN = "docs/DESIGN.md";
const SECTIONS = "docs/design/sections";
const AREAS = "docs/design/areas";

if (import.meta.main) {
  const root = process.cwd();
  const now = scan(root);
  if (process.argv.includes("--update")) {
    const baseline = { ...JSON.parse(readFileSync(join(root, BASELINE), "utf8")), files: now.files }; // keeps `coldRead` (#5882)
    writeFileSync(join(root, BASELINE), JSON.stringify(baseline, null, 2) + "\n");
    writeFileSync(join(root, QUIET_DEBT), JSON.stringify(quietCounts(scanQuiet(root)), null, 2) + "\n");
    console.log(`wrote ${BASELINE}`);
  } else {
    const base: Baseline = JSON.parse(readFileSync(join(root, BASELINE), "utf8"));
    const debt: QuietDebt = JSON.parse(readFileSync(join(root, QUIET_DEBT), "utf8"));
    const problems = [...compare(base, now, designText(root), areaFiles(root)), ...compareQuiet(debt, scanQuiet(root)), ...scanBanner(root), ...scanOverlay(root), ...scanCards(root), ...scanStranger(root)];
    for (const p of problems) console.error(p);
    if (problems.length) process.exit(1);
    console.log("design: no colour, size or component added outside the system");
  }
}
