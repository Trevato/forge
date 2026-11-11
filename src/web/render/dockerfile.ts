/**
 * A `Dockerfile`, `Containerfile` or `*.Dockerfile` as its stages: each `FROM`
 * starts a block headed by its image (and `AS` name), with the `EXPOSE`d
 * ports and the `ENV` names (never their values) at the head; every other
 * instruction is one row, keyword and arguments, continuation lines joined.
 * Comment lines (and parser directives) are dropped. `ARG`s before the first
 * `FROM` sit in a block of their own. A file with an unknown instruction, or
 * no `FROM`, is not drawn: the source shows with the reason. Heredoc bodies
 * (`RUN <<EOF` … `EOF`) are skipped up to their terminator; the instruction
 * line stays. Every string is escaped and cut to `TEXT_CAP`; at most
 * `ROW_CAP` instructions are drawn.
 */

import { escapeHtml, html, raw } from "../html.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

export const ROW_CAP = 500;
const TEXT_CAP = 400;

const KEYWORDS: ReadonlySet<string> = new Set([
  "FROM", "RUN", "CMD", "LABEL", "MAINTAINER", "EXPOSE", "ENV", "ADD", "COPY", "ENTRYPOINT",
  "VOLUME", "USER", "WORKDIR", "ARG", "ONBUILD", "STOPSIGNAL", "HEALTHCHECK", "SHELL",
]);

export interface Row {
  readonly keyword: string;
  readonly args: string;
}
export interface Stage {
  /** Empty for the `ARG`s before the first `FROM`. */
  readonly image: string;
  readonly name: string;
  readonly ports: string[];
  readonly env: string[];
  readonly rows: Row[];
}
export type Dockerfile =
  | { readonly stages: Stage[]; readonly total: number; readonly shown: number }
  | { readonly error: string };

const cut = (s: string): string => s.slice(0, TEXT_CAP);

/** The heredoc terminators an instruction line opens (`<<EOF`, `<<-"EOF"`), in order. */
function heredocs(instruction: string): { word: string; strip: boolean }[] {
  if (!/^(RUN|COPY|ADD)\s/i.test(instruction)) return [];
  const out: { word: string; strip: boolean }[] = [];
  const re = /(?<!<)<<(-?)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_]\w*))/g;
  for (let m = re.exec(instruction); m !== null; m = re.exec(instruction)) out.push({ word: m[2] ?? m[3] ?? m[4]!, strip: m[1] === "-" });
  return out;
}

/** Logical instructions: comments dropped, `\` continuations joined, heredoc bodies skipped. */
function instructions(source: string): string[] {
  const out: string[] = [];
  let cur: string | undefined;
  let pending: { word: string; strip: boolean }[] = [];
  for (const line of source.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (pending.length > 0) {
      const end = pending[0]!;
      if ((end.strip ? line.replace(/^\t+/, "") : line).trimEnd() === end.word) pending.shift();
      continue;
    }
    const t = line.trim();
    if (t.startsWith("#")) continue; // also inside a continuation, as Docker does
    if (t === "") continue;
    const more = /\\$/.test(t);
    const text = more ? t.slice(0, -1).trimEnd() : t;
    cur = cur === undefined ? text : `${cur} ${text}`;
    if (!more) {
      out.push(cur);
      pending = heredocs(cur);
      cur = undefined;
    }
  }
  if (cur !== undefined) out.push(cur);
  return out;
}

/** Names set by `ENV a=1 b="x y"` or the old `ENV a some value`. */
function envNames(args: string): string[] {
  if (!/^[^\s=]+=/.test(args)) return [args.split(/\s+/)[0] ?? ""].filter((n) => n !== "");
  const names: string[] = [];
  const re = /([^\s=]+)=(?:"(?:[^"\\]|\\.)*"|'[^']*'|(?:\\.|\S)*)/g;
  for (let m = re.exec(args); m !== null; m = re.exec(args)) names.push(m[1]!);
  return names;
}

export function parseDockerfile(source: string): Dockerfile {
  const stages: Stage[] = [];
  let total = 0;
  let shown = 0;
  let sawFrom = false;
  for (const line of instructions(source)) {
    const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(line);
    const keyword = m![1]!.toUpperCase();
    const args = (m![2] ?? "").trim();
    if (!KEYWORDS.has(keyword)) return { error: `"${cut(m![1]!).slice(0, 40)}" is not a Dockerfile instruction` };
    if (keyword === "FROM") {
      const words = args.split(/\s+/).filter((w) => !w.startsWith("--"));
      if (words[0] === undefined) return { error: "a FROM has no image" };
      const as = words[1]?.toUpperCase() === "AS" ? (words[2] ?? "") : "";
      stages.push({ image: cut(words[0]), name: cut(as), ports: [], env: [], rows: [] });
      sawFrom = true;
      continue;
    }
    if (!sawFrom) {
      if (keyword !== "ARG") return { error: `${keyword} comes before the first FROM` };
      if (stages.length === 0) stages.push({ image: "", name: "", ports: [], env: [], rows: [] });
    }
    const stage = stages[stages.length - 1]!;
    if (keyword === "EXPOSE") {
      for (const p of args.split(/\s+/)) if (p !== "" && stage.ports.length < ROW_CAP) stage.ports.push(cut(p));
      continue;
    }
    if (keyword === "ENV") {
      for (const n of envNames(args)) if (stage.env.length < ROW_CAP) stage.env.push(cut(n));
      continue;
    }
    total++;
    if (shown >= ROW_CAP) continue;
    shown++;
    stage.rows.push({ keyword, args: cut(args) });
  }
  if (!sawFrom) return { error: "it has no FROM" };
  return { stages, total, shown };
}

export const moreLine = (n: number): string => `${n.toLocaleString()} more instruction${n === 1 ? "" : "s"} not shown`;

export function dockerfile(input: RenderInput): Rendered {
  const doc = parseDockerfile(new TextDecoder().decode(input.body));
  if ("error" in doc) return { content: html``, lines: 0, fallback: `This file is not drawn as a build: ${doc.error}.` };
  let out = "";
  let n = 0;
  for (const s of doc.stages) {
    if (s.image !== "") n++;
    const title = s.image === "" ? "Before the first stage" : `${s.image}${s.name === "" ? "" : ` as ${s.name}`}`;
    const label = s.image === "" ? title : `Stage ${n}: ${title}`;
    let head = "";
    if (s.ports.length > 0) head += `<p class="small">Exposes ${s.ports.map((p) => `<code>${escapeHtml(p)}</code>`).join(" ")}</p>`;
    if (s.env.length > 0) head += `<p class="small">Sets ${s.env.map((p) => `<code>${escapeHtml(p)}</code>`).join(" ")}</p>`;
    let rows = "";
    for (const r of s.rows) rows += `<tr><td><code>${escapeHtml(r.keyword)}</code></td><td><code>${escapeHtml(r.args)}</code></td></tr>`;
    const table =
      rows === ""
        ? ""
        : `<table class="table" data-dense aria-label="${escapeHtml(title)} instructions"><thead><tr><th scope="col">Instruction</th><th scope="col">Arguments</th></tr></thead><tbody>${rows}</tbody></table>`;
    out += `<section><h3>${escapeHtml(label)}</h3>${head}${table}</section>`;
  }
  if (doc.total > doc.shown) out += `<p class="muted small">${moreLine(doc.total - doc.shown)}</p>`;
  const built = doc.stages.filter((s) => s.image !== "").length;
  const lead = "What this image is built from.";
  return {
    content: html`<div class="dockerfile-view"><p>${lead}</p>${raw(out)}</div>`,
    lines: 0,
    summary: `${built} ${built === 1 ? "stage" : "stages"} · ${fileSize(input.size)}`,
  };
}
