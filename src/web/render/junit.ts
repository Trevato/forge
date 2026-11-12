/**
 * A JUnit XML report as its results: totals (tests, failures, errors,
 * skipped, time) at the top, then each suite with its failing and erroring
 * cases first (name, class, time, the message, the first `BODY_LINES` lines of
 * the body in a `<pre>`) and the passing ones folded. The XML reader here is
 * the whole of its parser: one forward scan, no dependency, and no entity
 * beyond the five predefined and numeric character references. A DOCTYPE
 * (where entity expansion lives) is refused, as are unbalanced tags, nesting
 * past `MAX_DEPTH` and more than `MAX_NODES` elements; the page then falls
 * back to the source with the reason. At most `CASE_CAP` cases are drawn,
 * failing ones before any passing one, and the page says how many were left
 * out. Every string is escaped.
 */

import { escapeHtml, html, raw } from "../html.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

export const CASE_CAP = 2000;
export const BODY_LINES = 40;
const MAX_DEPTH = 100;
const MAX_NODES = 500_000;
/** Text kept per element: a body is shown by its first lines only. */
const MAX_TEXT = 64_000;
const MAX_BODY_CHARS = 8000;

export interface XmlNode {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  text: string;
}
export type Xml = { readonly root: XmlNode } | { readonly error: string };

const NAMED: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** The five predefined entities and numeric references; any other `&…;` stays as written. */
function decode(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (m, ref: string) => {
    if (ref[0] !== "#") return NAMED[ref] ?? m;
    const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    const ok = code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && code !== 0xfffe && code !== 0xffff);
    return ok ? String.fromCodePoint(code) : m;
  });
}

const NAME = /[^\s=\/>"'<]+/y;
const ATTR = /\s*([^\s=\/>"'<]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;

/** Read XML into a tree of elements. Pure; never throws; one pass over the text. */
export function parseXml(source: string): Xml {
  const s = source.replace(/^﻿/, "");
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let nodes = 0;
  let i = 0;
  const addText = (t: string): void => {
    const top = stack[stack.length - 1];
    if (top !== undefined && top.text.length < MAX_TEXT) top.text += t;
  };
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    const end = lt === -1 ? s.length : lt;
    if (end > i) {
      const t = s.slice(i, end);
      if (stack.length > 0) addText(decode(t));
      else if (t.trim() !== "") return { error: "it has text outside its root element" };
    }
    if (lt === -1) break;
    i = lt;
    if (s.startsWith("<!--", i)) {
      const e = s.indexOf("-->", i + 4);
      if (e === -1) return { error: "a comment is never closed" };
      i = e + 3;
    } else if (s.startsWith("<![CDATA[", i)) {
      const e = s.indexOf("]]>", i + 9);
      if (e === -1) return { error: "a CDATA section is never closed" };
      if (stack.length === 0) return { error: "it has text outside its root element" };
      addText(s.slice(i + 9, e));
      i = e + 3;
    } else if (s.startsWith("<?", i)) {
      const e = s.indexOf("?>", i + 2);
      if (e === -1) return { error: "a processing instruction is never closed" };
      i = e + 2;
    } else if (s.startsWith("<!", i)) {
      return { error: "it has a DOCTYPE or declaration, which is not read (entity expansion)" };
    } else if (s.startsWith("</", i)) {
      const e = s.indexOf(">", i + 2);
      if (e === -1) return { error: "a closing tag is never finished" };
      const name = s.slice(i + 2, e).trim();
      const open = stack.pop();
      if (open === undefined || open.name !== name) return { error: `the closing tag </${name.slice(0, 40)}> does not match an open element` };
      i = e + 1;
    } else {
      NAME.lastIndex = i + 1;
      const m = NAME.exec(s);
      if (m === null) return { error: "a tag has no name" };
      const attrs: Record<string, string> = {};
      let p = NAME.lastIndex;
      for (;;) {
        ATTR.lastIndex = p;
        const a = ATTR.exec(s);
        if (a === null) break;
        attrs[a[1]!] = decode(a[2] ?? a[3] ?? "");
        p = ATTR.lastIndex;
      }
      while (p < s.length && /\s/.test(s[p]!)) p++;
      const selfClosing = s[p] === "/";
      if (selfClosing) p++;
      if (s[p] !== ">") return { error: "a tag is malformed" };
      if (++nodes > MAX_NODES) return { error: "it has too many elements" };
      const node: XmlNode = { name: m[0], attrs, children: [], text: "" };
      const parent = stack[stack.length - 1];
      if (parent !== undefined) parent.children.push(node);
      else if (root !== undefined) return { error: "it has more than one root element" };
      else root = node;
      if (!selfClosing) {
        if (stack.length >= MAX_DEPTH) return { error: "its elements nest too deeply" };
        stack.push(node);
      }
      i = p + 1;
    }
  }
  if (stack.length > 0) return { error: `<${stack[stack.length - 1]!.name}> is never closed` };
  if (root === undefined) return { error: "it has no root element" };
  return { root };
}

export type Status = "failed" | "error" | "skipped" | "passed";
export interface Case {
  readonly name: string;
  readonly classname: string;
  readonly time: number;
  readonly status: Status;
  readonly message: string;
  readonly kind: string;
  readonly body: string;
}
export interface Suite {
  readonly name: string;
  readonly cases: readonly Case[];
}
export interface Totals {
  readonly tests: number;
  readonly failures: number;
  readonly errors: number;
  readonly skipped: number;
  readonly time: number;
}
export type Junit = { readonly suites: Suite[]; readonly totals: Totals } | { readonly error: string };

const seconds = (v: string | undefined): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

function toCase(n: XmlNode): Case {
  const bad = n.children.find((c) => c.name === "failure" || c.name === "error");
  const skip = n.children.find((c) => c.name === "skipped");
  const status: Status = bad === undefined ? (skip !== undefined ? "skipped" : "passed") : bad.name === "failure" ? "failed" : "error";
  const el = bad ?? skip;
  return {
    name: n.attrs.name ?? "",
    classname: n.attrs.classname ?? "",
    time: seconds(n.attrs.time),
    status,
    message: el?.attrs.message ?? "",
    kind: el?.attrs.type ?? "",
    body: el?.text ?? "",
  };
}

/** Parse a JUnit report's text. Pure; never throws. */
export function parseJunit(source: string): Junit {
  const xml = parseXml(source);
  if ("error" in xml) return { error: xml.error };
  const root = xml.root;
  if (root.name !== "testsuites" && root.name !== "testsuite") return { error: "its root element is not <testsuites> or <testsuite>" };
  const suites: Suite[] = [];
  // Iterative walk: a suite is any <testsuite> with cases of its own.
  const work: XmlNode[] = [root];
  while (work.length > 0) {
    const n = work.pop()!;
    const cases = n.children.filter((c) => c.name === "testcase").map(toCase);
    if (n.name === "testsuite" && (cases.length > 0 || !n.children.some((c) => c.name === "testsuite")))
      suites.push({ name: n.attrs.name ?? "", cases });
    for (let k = n.children.length - 1; k >= 0; k--) if (n.children[k]!.name === "testsuite") work.push(n.children[k]!);
  }
  const all = suites.flatMap((s) => s.cases);
  const count = (st: Status): number => all.filter((c) => c.status === st).length;
  const declared = root.name === "testsuites" && root.attrs.time !== undefined ? seconds(root.attrs.time) : undefined;
  const time = declared ?? all.reduce((t, c) => t + c.time, 0);
  return { suites, totals: { tests: all.length, failures: count("failed"), errors: count("error"), skipped: count("skipped"), time } };
}

const fmtTime = (t: number): string => `${Number(t.toFixed(3))} s`;

function body(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "").split("\n");
  let out = lines.slice(0, BODY_LINES).join("\n");
  const cut = lines.length > BODY_LINES;
  if (out.length > MAX_BODY_CHARS) out = out.slice(0, MAX_BODY_CHARS);
  if (out === "") return "";
  return `<pre>${escapeHtml(out)}</pre>${cut ? `<p class="muted small">${(lines.length - BODY_LINES).toLocaleString()} more lines in the raw file.</p>` : ""}`;
}

const label = (c: Case): string => (c.classname === "" ? c.name : c.name === "" ? c.classname : `${c.classname} › ${c.name}`) || "(unnamed)";

/** One plain sentence of what the file is and how it went. */
export function leadSentence(t: Totals): string {
  const bad = t.failures + t.errors;
  return bad === 0 ? `This is a test report: all ${t.tests.toLocaleString()} tests pass.` : `This is a test report: ${bad.toLocaleString()} of ${t.tests.toLocaleString()} tests fail.`;
}

export function junit(input: RenderInput): Rendered {
  const doc = parseJunit(new TextDecoder().decode(input.body));
  if ("error" in doc) return { content: html``, lines: 0, fallback: `This file is not drawn as test results: ${doc.error}.` };
  const t = doc.totals;
  const badTotal = t.failures + t.errors;
  let badLeft = Math.min(badTotal, CASE_CAP);
  let goodLeft = CASE_CAP - badLeft;
  let drawn = 0;
  let groups = "";
  for (const suite of doc.suites) {
    const bad = suite.cases.filter((c) => c.status === "failed" || c.status === "error").slice(0, badLeft);
    badLeft -= bad.length;
    const good = suite.cases.filter((c) => c.status === "passed" || c.status === "skipped").slice(0, goodLeft);
    goodLeft -= good.length;
    drawn += bad.length + good.length;
    groups += `<h3>${escapeHtml(suite.name || "Unnamed suite")} <span class="muted small">${suite.cases.length.toLocaleString()} ${suite.cases.length === 1 ? "test" : "tests"}</span></h3>`;
    if (bad.length > 0) {
      const rows = bad
        .map(
          (c) =>
            `<tr><td>${escapeHtml(label(c))}</td><td>${c.status === "error" ? "error" : "failed"}${c.kind === "" ? "" : ` · ${escapeHtml(c.kind)}`}</td><td>${escapeHtml(c.message.replace(/\s+/g, " "))}</td><td>${fmtTime(c.time)}</td></tr>`,
        )
        .join("");
      groups += `<table class="table" data-dense aria-label="${escapeHtml(suite.name || "Unnamed suite")} failing cases"><thead><tr><th scope="col">Case</th><th scope="col">Result</th><th scope="col">Message</th><th scope="col">Time</th></tr></thead><tbody>${rows}</tbody></table>`;
      for (const c of bad) {
        const b = body(c.body);
        if (b !== "") groups += `<p class="muted small">${escapeHtml(label(c))}</p>${b}`;
      }
    }
    if (good.length > 0) {
      const items = good.map((c) => `<li>${escapeHtml(label(c))} <span class="muted small">${c.status === "skipped" ? "skipped" : fmtTime(c.time)}</span></li>`).join("");
      groups += `<details><summary>${good.length.toLocaleString()} passing or skipped</summary><ul>${items}</ul></details>`;
    }
  }
  const out = t.tests - drawn;
  const more =
    out > 0
      ? `<p class="muted small">Showing ${drawn.toLocaleString()} of ${t.tests.toLocaleString()} cases, ${out.toLocaleString()} left out. The rest is in the raw file.</p>`
      : "";
  const tally = `${leadSentence(t)} ${t.tests.toLocaleString()} tests · ${t.failures.toLocaleString()} failures · ${t.errors.toLocaleString()} errors · ${t.skipped.toLocaleString()} skipped · ${fmtTime(t.time)}`;
  const content = html`<div class="junit-view"><p>${tally}</p>${raw(groups)}${raw(more)}</div>`;
  const verdict = badTotal === 0 ? "all passing" : `${badTotal.toLocaleString()} failing`;
  return { content, lines: 0, summary: `${t.tests.toLocaleString()} tests · ${verdict} · ${fileSize(input.size)}` };
}
