/**
 * The covered-page rule (#11831), shared by the design lint
 * (`scripts/design-lint.ts`) and the release preflight (#11916), which runs
 * it over a candidate tree before the swap: a page covered by something
 * closed never ships, whether it came through a pull or straight to a release.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

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

/** Every `/* css *\/ \`…\`` template in `text`, with the offset where each one's css starts. */
export function cssBlocksAt(text: string): { css: string; at: number }[] {
  const out: { css: string; at: number }[] = [];
  const re = /\/\* css \*\/\s*`((?:[^`\\]|\\.)*)`/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ css: m[1]!, at: m.index + m[0].length - 1 - m[1]!.length });
  return out;
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

