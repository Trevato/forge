/**
 * Moving every cue of a subtitle file (SubRip, WebVTT) by an offset: the
 * offset as typed, the commit message it is saved under, and the shift
 * itself. Plain data in, plain data out; the page, the terminal and the
 * action (`actions/subtitle_shift.ts`) share it.
 */

/** A timestamp: SubRip `HH:MM:SS,mmm` or WebVTT `[HH:]MM:SS.mmm`. */
export const TIME = String.raw`(?:\d{1,}:)?\d{1,2}:\d{2}[.,]\d{1,3}`;

/** The most a shift may move a file, either way, in seconds. */
export const MAX_SHIFT_SECONDS = 3600;

/** An offset in seconds as typed: a signed decimal, or the reason it was refused. */
export function parseOffset(text: string): { ok: true; ms: number } | { ok: false; why: string } {
  const t = text.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(t))
    return { ok: false, why: "Give the offset as a number of seconds, like 2.5 or -1." };
  const seconds = Number(t);
  if (!Number.isFinite(seconds) || Math.abs(seconds) > MAX_SHIFT_SECONDS)
    return { ok: false, why: `The offset can be at most ${MAX_SHIFT_SECONDS} seconds either way.` };
  return { ok: true, ms: Math.round(seconds * 1000) };
}

/** The commit message a shift is saved under: "Shift subtitles by +2.5 s". */
export function shiftMessage(ms: number): string {
  const seconds = ms / 1000;
  return `Shift subtitles by ${seconds >= 0 ? "+" : "-"}${Math.abs(seconds)} s`;
}

const STAMP = /^(?:(\d+):)?(\d{1,2}):(\d{2})([.,])(\d{1,3})$/;
const SHIFT_LINE = new RegExp(String.raw`^(\s*)(${TIME})(\s*-->\s*)(${TIME})(.*)$`);

function shiftStamp(stamp: string, ms: number): string {
  const m = STAMP.exec(stamp)!;
  const total =
    ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 +
    Number(m[5]!.padEnd(3, "0")) +
    ms;
  const t = Math.max(0, total);
  const h = Math.floor(t / 3_600_000);
  const two = (n: number): string => String(n).padStart(2, "0");
  const rest = `${two(Math.floor(t / 60_000) % 60)}:${two(Math.floor(t / 1000) % 60)}${m[4]}${String(t % 1000).padStart(3, "0")}`;
  // An hour field keeps the digits it had ("1:02:03" stays "1:02:03"); a stamp
  // without one grows it only when the shift carries it past 59:59.
  const hours = m[1] === undefined ? two(h) : String(h).padStart(m[1].length, "0");
  return m[1] !== undefined || h > 0 ? `${hours}:${rest}` : rest;
}

/**
 * Move every cue's start and end by `ms` (signed), never below zero. Only the
 * two timestamps of a timing line change; numbering, settings, text and line
 * endings (LF or CRLF) are kept byte for byte. A timestamp is rewritten as
 * MM:SS.mmm with three millisecond digits, its hours keeping their width. Pure; never throws.
 */
export function shiftCues(text: string, ms: number): { text: string; cues: number } {
  const lines = text.split("\n");
  const vtt = /^(?:﻿)?WEBVTT(?:[ \t]|$)/.test(lines[0] ?? "");
  let cues = 0;
  let inBlock = false;
  let timed = false;
  let skip = false;
  const out = lines.map((line, i) => {
    if (line.trim() === "") {
      inBlock = false;
      return line;
    }
    if (!inBlock) {
      inBlock = true;
      timed = false;
      skip = vtt && (i === 0 || /^(NOTE|STYLE|REGION)(?:[ \t]|$)/.test(line));
    }
    if (skip || timed || !line.includes("-->")) return line;
    timed = true;
    const cr = line.endsWith("\r") ? "\r" : "";
    const m = SHIFT_LINE.exec(cr === "" ? line : line.slice(0, -1));
    if (m === null) return line;
    cues++;
    return `${m[1]}${shiftStamp(m[2]!, ms)}${m[3]}${shiftStamp(m[4]!, ms)}${m[5]}${cr}`;
  });
  return { text: out.join("\n"), cues };
}

