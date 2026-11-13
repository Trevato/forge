/**
 * A subtitle file (SubRip `.srt`, WebVTT `.vtt`) as a transcript: one row per
 * cue, its start time and its text. Tags inside a cue (`<i>`, `<v Name>`,
 * `<00:01.000>`, `{\an8}`) are stripped, then the text is escaped. A cue that
 * does not parse is named in one line and the rest still draws.
 *
 * Formats: SubRip, "HH:MM:SS,mmm --> HH:MM:SS,mmm"; WebVTT, W3C
 * "WebVTT: The Web Video Text Tracks Format" §4, where hours are optional and
 * the separator is a dot. Both are accepted in either file.
 */

import { escapeHtml, html, raw, type Html } from "../html.ts";
import { TIME } from "../../core/subtitle_shift.ts";
import { btn, field, fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

/** Cues drawn, whatever the file holds. */
export const CUE_CAP = 5_000;
export interface Cue {
  readonly start: string;
  readonly text: string;
}
export interface Failure {
  /** The cue's number or id when it has one, else its position. */
  readonly name: string;
  /** 1-based line in the file where the cue starts. */
  readonly line: number;
  readonly why: string;
}
export interface Transcript {
  readonly cues: Cue[];
  readonly failures: Failure[];
}


const TIMING = new RegExp(String.raw`^\s*(${TIME})\s*-->\s*(${TIME})(?:\s.*)?$`);

/** Tags and SubRip/ASS style overrides removed from cue text. */
export const stripTags = (text: string): string =>
  text.replace(/<\/?[A-Za-z0-9][^>\n]*>/g, "").replace(/\{\\[^}\n]*\}/g, "");

/** Parse a subtitle file's text. Pure; never throws. */
export function parseSubtitles(source: string): Transcript {
  const lines = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const cues: Cue[] = [];
  const failures: Failure[] = [];
  let i = 0;
  let position = 0;
  // A WebVTT file opens on its signature line, which is not a cue.
  const vtt = /^WEBVTT(?:[ \t]|$)/.test(lines[0] ?? "");
  while (i < lines.length) {
    if ((lines[i] ?? "").trim() === "") {
      i++;
      continue;
    }
    const first = i;
    const block: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "") block.push(lines[i++]!);
    if (vtt && first === 0) continue;
    if (vtt && /^(NOTE|STYLE|REGION)(?:[ \t]|$)/.test(block[0]!)) continue;
    position++;
    const at = block.findIndex((l) => l.includes("-->"));
    const name = at > 0 ? block[0]!.trim().slice(0, 40) : String(position);
    if (at === -1) {
      failures.push({ name, line: first + 1, why: "no timing line, add an arrow line (00:00:01,000 --> 00:00:02,000)" });
      continue;
    }
    const m = TIMING.exec(block[at]!);
    if (m === null) {
      failures.push({ name, line: first + at + 1, why: "unreadable timing, check the arrow line (00:00:01,000 --> 00:00:02,000)" });
      continue;
    }
    cues.push({
      start: m[1]!.replace(",", "."),
      text: stripTags(block.slice(at + 1).join("\n")).trim(),
    });
  }
  return { cues, failures };
}

/** The one form on a writer's subtitle page; it posts to the file edit route. */
function shiftForm(shift: NonNullable<RenderInput["shift"]>): Html {
  return html`<form method="post" action="${shift.action}" class="mt">
    <input type="hidden" name="ref" value="${shift.ref}">
    <input type="hidden" name="path" value="${shift.path}">
    ${field({ name: "shift", label: "Shift every cue by (seconds)", value: "0", placeholder: "2.5 or -1", required: true, autocomplete: "off" })}
    <div class="form-actions">${btn("Shift and save", { variant: "primary" })}</div>
  </form>`;
}

export function subtitles(input: RenderInput): Rendered {
  const { cues, failures } = parseSubtitles(new TextDecoder().decode(input.body));
  if (cues.length === 0 && failures.length === 0)
    return { content: html``, lines: 0, fallback: "This file holds no cues." };
  const shown = cues.slice(0, CUE_CAP);
  let rows = "";
  for (const c of shown)
    rows += `<tr><td><time>${escapeHtml(c.start)}</time></td><td>${escapeHtml(c.text).replace(/\n/g, "<br>")}</td></tr>`;
  const notes: string[] = [];
  if (failures.length > 0) {
    const f = failures[0]!;
    notes.push(
      `${failures.length} ${failures.length === 1 ? "cue" : "cues"} could not be read, first is cue ${escapeHtml(f.name)} (line ${f.line}): ${escapeHtml(f.why)}.`,
    );
  }
  if (cues.length > CUE_CAP)
    notes.push(
      `Showing ${CUE_CAP.toLocaleString()} of ${cues.length.toLocaleString()} cues. The rest is in the raw file.`,
    );
  const name = input.path.slice(input.path.lastIndexOf("/") + 1);
  const content = html`<table class="table subs-view" data-dense aria-label="${name} transcript">
    <thead><tr><th scope="col">Start</th><th scope="col">Text</th></tr></thead>
    <tbody>${raw(rows)}</tbody>
  </table>${raw(notes.map((n) => `<p class="muted small">${n}</p>`).join(""))}${input.shift === undefined ? null : shiftForm(input.shift)}`;
  return {
    content,
    lines: 0,
    summary: `${cues.length.toLocaleString()} cues · ${fileSize(input.size)}`,
  };
}
