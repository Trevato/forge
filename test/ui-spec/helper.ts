/**
 * One helper for component specs (#12016). It takes a component's rendered
 * HTML and reports what a keyboard, a screen reader, a thumb and a
 * right-to-left reader would trip over. No browser, no dependency: a small
 * tag parser and the forge's own stylesheet, read as text.
 *
 *   expectAccessible(btn("Save"));        // throws, listing every problem
 *   problems(markup)                      // the list, for a negative test
 */
import { expect } from "bun:test";
import { components } from "../../src/web/style/components.ts";

export interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
  parent: Node | null;
  /** Text directly inside this element, in order with children flattened by `text()`. */
  texts: string[];
}

const VOID = new Set(["input", "br", "hr", "img", "meta", "link", "use", "path", "circle", "rect", "source"]);

export function parse(markup: string | { toString(): string }): Node {
  const src = String(markup).replace(/<!--[\s\S]*?-->/g, "");
  const root: Node = { tag: "#root", attrs: {}, children: [], parent: null, texts: [] };
  let cur = root;
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m[4] !== undefined) {
      cur.texts.push(decode(m[4]));
      continue;
    }
    const tag = m[2]!.toLowerCase();
    if (m[1]) {
      let n: Node | null = cur;
      while (n && n.tag !== tag) n = n.parent;
      if (n?.parent) cur = n.parent;
      continue;
    }
    const attrs: Record<string, string> = {};
    const are = /([^\s=\/"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    for (let a = are.exec(m[3]!); a; a = are.exec(m[3]!)) {
      attrs[a[1]!.toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? "");
    }
    const node: Node = { tag, attrs, children: [], parent: cur, texts: [] };
    cur.children.push(node);
    if (!VOID.has(tag) && !m[3]!.trimEnd().endsWith("/")) cur = node;
  }
  return root;
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&");
}

export function all(n: Node): Node[] {
  return n.children.flatMap((c) => [c, ...all(c)]);
}

/** Visible-to-a-screen-reader text of an element. */
function text(n: Node): string {
  if (n.attrs["aria-hidden"] === "true") return "";
  let out = "";
  const walk = (x: Node) => {
    if (x.attrs["aria-hidden"] === "true") return;
    if (x.tag === "img" && x.attrs.alt) out += ` ${x.attrs.alt}`;
    out += ` ${x.texts.join(" ")}`;
    x.children.forEach(walk);
  };
  walk(n);
  return out.replace(/\s+/g, " ").trim();
}

function byId(root: Node, id: string): Node | undefined {
  return all(root).find((n) => n.attrs.id === id);
}

function rootOf(n: Node): Node {
  let r = n;
  while (r.parent) r = r.parent;
  return r;
}

export function accessibleName(n: Node): string {
  const root = rootOf(n);
  const by = n.attrs["aria-labelledby"];
  if (by) {
    const t = by.split(/\s+/).map((id) => byId(root, id)).filter(Boolean).map((x) => text(x!)).join(" ").trim();
    if (t) return t;
  }
  if (n.attrs["aria-label"]?.trim()) return n.attrs["aria-label"]!.trim();
  if (n.tag === "input" && ["submit", "button", "reset"].includes(n.attrs.type ?? "")) {
    if (n.attrs.value?.trim()) return n.attrs.value.trim();
  }
  if (["input", "select", "textarea"].includes(n.tag)) {
    const id = n.attrs.id;
    const lab = all(root).find((l) => l.tag === "label" && id !== undefined && l.attrs.for === id);
    if (lab && text(lab)) return text(lab);
    for (let p = n.parent; p; p = p.parent) if (p.tag === "label" && text(p)) return text(p);
  } else {
    const t = text(n);
    if (t) return t;
  }
  return n.attrs.title?.trim() ?? "";
}

const IMPLICIT: Record<string, string> = {
  button: "button", summary: "button", select: "combobox", textarea: "textbox",
};

export function roleOf(n: Node): string {
  if (n.attrs.role) return n.attrs.role;
  if (n.tag === "a") return n.attrs.href !== undefined ? "link" : "";
  if (n.tag === "input") {
    const t = n.attrs.type ?? "text";
    if (t === "hidden") return "";
    if (["submit", "button", "reset", "image"].includes(t)) return "button";
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    if (t === "range") return "slider";
    if (t === "number") return "spinbutton";
    return "textbox";
  }
  return IMPLICIT[n.tag] ?? "";
}

const NATIVE = new Set(["a", "button", "input", "select", "textarea", "summary"]);

/**
 * An element a person can act on: a native control, an ARIA widget role, a tabindex, or a
 * click handler.
 */
export function controls(root: Node): Node[] {
  return all(root).filter((n) => {
    if (n.tag === "input" && n.attrs.type === "hidden") return false;
    if (n.tag === "a" && n.attrs.href === undefined && !n.attrs.role && n.attrs.tabindex === undefined) return false;
    return NATIVE.has(n.tag) || n.attrs.role !== undefined || n.attrs.tabindex !== undefined || hasHandler(n, /^onclick$/);
  });
}

const hasHandler = (n: Node, re: RegExp) => Object.keys(n.attrs).some((k) => re.test(k));
const WIDGET = /^(button|link|checkbox|radio|tab|menuitem|menuitemcheckbox|menuitemradio|switch|option|combobox|textbox|slider|spinbutton)$/;

// ---- the stylesheet, as the tap-target rules it holds ----

interface Rule { media: string; selector: string; body: string; order: number }

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "");
}

export function parseCss(css: string): Rule[] {
  const out: Rule[] = [];
  let order = 0;
  const block = (src: string, media: string) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf("{", i);
      if (open < 0) break;
      const head = src.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
        j++;
      }
      const body = src.slice(open + 1, j - 1);
      if (head.startsWith("@media")) block(body, head);
      else if (head.startsWith("@layer") || head.startsWith("@supports")) block(body, media);
      else if (!head.startsWith("@")) {
        for (const selector of head.split(",")) out.push({ media, selector: selector.trim(), body, order: order++ });
      }
      i = j;
    }
  };
  block(stripComments(css), "");
  return out;
}

const RULES = parseCss(components);

interface Compound { tag?: string; classes: string[]; attrs: [string, string | undefined][] }

function compounds(selector: string): { c: Compound; comb: " " | ">" }[] | null {
  if (/[:+~*]/.test(selector.replace(/\[[^\]]*\]/g, ""))) return null; // states, pseudo-elements, siblings: not a static size
  const parts = selector.replace(/\s*>\s*/g, " > ").split(/\s+/);
  const out: { c: Compound; comb: " " | ">" }[] = [];
  let comb: " " | ">" = " ";
  for (const p of parts) {
    if (p === ">") { comb = ">"; continue; }
    const c: Compound = { classes: [], attrs: [] };
    const tag = /^[a-z][\w-]*/i.exec(p);
    if (tag) c.tag = tag[0].toLowerCase();
    for (const m of p.matchAll(/\.([\w-]+)/g)) c.classes.push(m[1]!);
    for (const m of p.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) c.attrs.push([m[1]!, m[2]]);
    out.push({ c, comb });
    comb = " ";
  }
  return out;
}

function matches(n: Node, c: Compound): boolean {
  if (c.tag && n.tag !== c.tag) return false;
  const cls = (n.attrs.class ?? "").split(/\s+/);
  if (!c.classes.every((k) => cls.includes(k))) return false;
  return c.attrs.every(([k, v]) => (v === undefined ? n.attrs[k] !== undefined : n.attrs[k] === v));
}

function selectorMatches(n: Node, chain: { c: Compound; comb: " " | ">" }[]): boolean {
  const go = (node: Node | null, i: number): boolean => {
    if (!node || !matches(node, chain[i]!.c)) return false;
    if (i === 0) return true;
    const comb = chain[i]!.comb;
    if (comb === ">") return go(node.parent, i - 1);
    for (let p = node.parent; p; p = p.parent) if (go(p, i - 1)) return true;
    return false;
  };
  return go(n, chain.length - 1);
}

const specificity = (c: { c: Compound }[]) => c.reduce((s, x) => s + x.c.classes.length * 10 + x.c.attrs.length * 10 + (x.c.tag ? 1 : 0), 0);

export interface Size { height?: number; width?: number }

/**
 * The size a thumb gets: base rules, then `(pointer: coarse)` rules, each by specificity then
 * source order.
 */
export function coarseSize(n: Node): Size {
  const hits: { rank: [number, number, number]; body: string }[] = [];
  for (const r of RULES) {
    const coarse = /pointer:\s*coarse/.test(r.media);
    if (r.media && !coarse) continue;
    const chain = compounds(r.selector);
    if (!chain || !selectorMatches(n, chain)) continue;
    hits.push({ rank: [coarse ? 1 : 0, specificity(chain), r.order], body: r.body });
  }
  hits.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2]);
  const size: Size = {};
  const px = (body: string, prop: string) => {
    const m = new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(body);
    return m ? Number(m[1]) : undefined;
  };
  const num0 = (body: string, prop: string) => new RegExp(`(?:^|[;\\s])${prop}:\\s*0\\s*[;}]?`).test(body + ";");
  for (const h of hits) {
    const mh = px(h.body, "min-height") ?? px(h.body, "height");
    if (mh !== undefined) size.height = mh;
    else if (num0(h.body, "min-height")) size.height = 0;
    const mw = px(h.body, "min-width") ?? px(h.body, "width");
    if (mw !== undefined) size.width = mw;
  }
  return size;
}

export const TAP = 44;

// ---- the checks ----

const PHYSICAL = /(^|[;\s])(margin|padding|border)-(left|right)\s*:|(^|[;\s])(left|right)\s*:|(^|[;\s])float\s*:|text-align\s*:\s*(left|right)\b|(^|[;\s])(border-(top|bottom)-(left|right)-radius)\s*:/i;

export interface Options {
  /** Skip the tap-target check (a component the stylesheet does not yet size to 44 px). */
  tapTargets?: boolean;
  /**
   * Tags allowed to have no height or width rule at all, named by the spec that needs it: a
   * control the stylesheet leaves unsized is a gap, and the spec says so out loud.
   */
  unsized?: string[];
  /** Rule selectors, as written in the stylesheet, whose physical left/right is known and kept. */
  physical?: string[];
}

/** Every problem in one component's rendered HTML; empty when it passes. */
export function problems(markup: string | { toString(): string }, o: Options = {}): string[] {
  const root = parse(markup);
  const out: string[] = [];
  const label = (n: Node) => `<${n.tag}${n.attrs.class ? ` class="${n.attrs.class}"` : ""}>`;
  const ids = new Map<string, number>();
  for (const n of all(root)) if (n.attrs.id) ids.set(n.attrs.id, (ids.get(n.attrs.id) ?? 0) + 1);
  for (const [id, k] of ids) if (k > 1) out.push(`duplicate id "${id}"`);

  for (const n of controls(root)) {
    const role = roleOf(n);
    if (!role) out.push(`${label(n)} has no role`);
    if (!accessibleName(n)) out.push(`${label(n)} (${role || "no role"}) has no accessible name`);
    const native = NATIVE.has(n.tag);
    if (!native && (role === "" || WIDGET.test(role) || hasHandler(n, /^onclick$/))) {
      if (n.attrs.tabindex === undefined) out.push(`${label(n)} acts like a control but is not a real control and has no tabindex`);
      if (!hasHandler(n, /^on(keydown|keyup|keypress)$/) && n.attrs["data-key"] === undefined) {
        out.push(`${label(n)} acts like a control but has no key handler`);
      }
    }
    if (o.tapTargets !== false && !(n.tag === "input" && n.attrs.type === "hidden")) {
      // A checkbox or radio is tapped through its label: the label is the target.
      let size = coarseSize(n);
      if (n.tag === "input" && /^(checkbox|radio)$/.test(n.attrs.type ?? "")) {
        for (let p = n.parent; p; p = p.parent) {
          if (p.tag === "label") { size = coarseSize(p); break; }
        }
      }
      if (size.height === undefined && size.width === undefined) {
        // Only a link inside running text is exempt: its line is its target.
        const prose = n.tag === "a" && n.parent !== null && n.parent.texts.join("").trim() !== "";
        if (!prose && !(o.unsized ?? []).includes(n.tag)) {
          out.push(`${label(n)} has no size rule: not measured at ${TAP}px (name it in "unsized")`);
        }
      }
      if (size.height !== undefined && size.height < TAP) out.push(`${label(n)} is ${size.height}px tall on a thumb; ${TAP}px needed`);
      if (size.width !== undefined && size.width < TAP) out.push(`${label(n)} is ${size.width}px wide on a thumb; ${TAP}px needed`);
    }
  }

  out.push(...physicalRules(root, o.physical ?? []));

  for (const n of all(root)) {
    const style = n.attrs.style;
    if (style && PHYSICAL.test(style)) out.push(`${label(n)} hard-codes left/right in inline style: ${style}`);
    if (["left", "right"].includes(n.attrs.align ?? "")) out.push(`${label(n)} hard-codes align="${n.attrs.align}"`);
  }
  return out;
}

// ---- right-to-left: the stylesheet rules the markup meets ----

/** A declaration that points at a side of the page, not at the start or end of a line. */
const PHYSICAL_DECL =
  /(?:^|[;\s])((?:margin|padding|border)-(?:left|right)(?:-[a-z]+)?|border-(?:top|bottom)-(?:left|right)-radius|left|right|float|clear|text-align|text-align-last)\s*:\s*([^;]*)/g;

/**
 * The rule's selector with states and pseudo-elements dropped: they do not change which node it
 * is on.
 */
function loose(selector: string): string {
  return selector.replace(/::?[a-z-]+(\([^)]*\))?/gi, "").replace(/\s+/g, " ").trim();
}

/** Physical-side declarations in the (every-media) rules that match a rendered node. */
export function physicalRules(root: Node, allowed: string[] = []): string[] {
  const out = new Set<string>();
  const nodes = all(root);
  for (const r of RULES) {
    if (allowed.includes(r.selector)) continue;
    const found: string[] = [];
    for (const m of r.body.matchAll(PHYSICAL_DECL)) {
      const [, prop, value] = m;
      if (prop === "text-align" || prop === "text-align-last") {
        if (!/^(left|right)\b/.test(value!.trim())) continue;
      } else if (prop === "float" || prop === "clear") {
        if (!/^(left|right)\b/.test(value!.trim())) continue;
      } else if (/^(left|right)$/.test(prop!) && /^(auto|unset|initial|inherit)\b/.test(value!.trim())) {
        continue;
      }
      found.push(`${prop}: ${value!.trim()}`);
    }
    if (found.length === 0) continue;
    const chain = compounds(loose(r.selector));
    if (!chain || !nodes.some((n) => selectorMatches(n, chain))) continue;
    for (const f of found) out.add(`stylesheet rule "${r.selector}" hard-codes ${f}`);
  }
  return [...out];
}

/** The markup as a right-to-left reader gets it. */
export function rtl(markup: string | { toString(): string }): string {
  return `<div dir="rtl">${markup}</div>`;
}

/**
 * Passes when the markup has no problems, and still none inside `dir="rtl"`. What makes the
 * right-to-left half real is `problems`: inline style, `align`, and every stylesheet rule that
 * matches a rendered node, are scanned for physical left/right, which does not flip with `dir`.
 * The wrapper adds `dir="rtl"` ancestry, so rules scoped to `[dir="rtl"]` are matched too.
 */
export function expectAccessible(markup: string | { toString(): string }, o: Options = {}): void {
  expect(problems(markup, o)).toEqual([]);
  expect(problems(rtl(markup), o)).toEqual([]);
}
