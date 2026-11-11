/**
 * A calendar file (iCalendar `.ics`, RFC 5545) as a list of its events: start,
 * end (or "all day"), summary and location, in file order. Lines are unfolded
 * (§3.1), VEVENT blocks read, DTSTART/DTEND taken with or without TZID, and
 * TEXT escapes (`\,` `\;` `\\` `\n`) undone. Every value is escaped on output.
 * A file that is not a calendar, or whose blocks do not close, falls back to
 * its source.
 */

import { escapeHtml, html, raw } from "../html.ts";
import { fileSize } from "../ui.ts";
import type { Rendered, RenderInput } from "./renderers.ts";

/** Events drawn, whatever the file holds. */
export const EVENT_CAP = 500;

export interface IcsEvent {
  /** `2026-03-01 09:00`, `2026-03-01`, with a zone note when the file gave one. */
  readonly start: string;
  /** Empty when the file gave no end. For an all-day event, the last day. */
  readonly end: string;
  readonly allDay: boolean;
  readonly summary: string;
  readonly location: string;
}

/** Parsed events, or why the file is not a calendar. */
export type Calendar = { readonly events: IcsEvent[] } | { readonly error: string };

/** RFC 5545 §3.1: a line that starts with a space or tab continues the last. */
export function unfold(source: string): string[] {
  const out: string[] = [];
  for (const line of source.replace(/^﻿/, "").split(/\r\n|\n|\r/)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

/** §3.3.11: undo `\\ \; \, \n \N`; an unknown escape keeps its character. */
export const unescapeText = (v: string): string =>
  v.replace(/\\([\s\S])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));

interface Prop {
  readonly name: string;
  readonly params: ReadonlyMap<string, string>;
  readonly value: string;
}

/** `NAME;PARAM=v;PARAM="a:b":value`, split at the first colon outside quotes. */
function property(line: string): Prop | undefined {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return undefined;
  const [name, ...rest] = line.slice(0, colon).split(";");
  const params = new Map<string, string>();
  for (const p of rest) {
    const eq = p.indexOf("=");
    if (eq > 0) params.set(p.slice(0, eq).toUpperCase(), p.slice(eq + 1).replace(/^"|"$/g, ""));
  }
  return { name: name!.toUpperCase(), params, value: line.slice(colon + 1) };
}

interface When {
  readonly text: string;
  readonly dateOnly: boolean;
  /** Days since the epoch, for an all-day end that is exclusive. */
  readonly day: number;
}

const DATE_TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/;

function when(p: Prop): When | undefined {
  const m = DATE_TIME.exec(p.value.trim());
  if (m === null) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  const day = Math.floor(Date.UTC(y, mo - 1, d) / 86_400_000);
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (m[4] === undefined || p.params.get("VALUE") === "DATE") return { text: date, dateOnly: true, day };
  if (Number(m[4]) > 23 || Number(m[5]) > 59) return undefined;
  const zone = m[7] === "Z" ? " UTC" : p.params.has("TZID") ? ` ${p.params.get("TZID")}` : "";
  return { text: `${date} ${m[4]}:${m[5]}${zone}`, dateOnly: false, day };
}

const isoDay = (day: number): string => new Date(day * 86_400_000).toISOString().slice(0, 10);

/** Parse a calendar's text. Pure; never throws. */
export function parseIcs(source: string): Calendar {
  const lines = unfold(source);
  if (!lines.some((l) => l.trim().toUpperCase() === "BEGIN:VCALENDAR"))
    return { error: "not a calendar: no BEGIN:VCALENDAR" };
  const events: IcsEvent[] = [];
  let props: Prop[] | undefined;
  // Components inside an event (VALARM) have their own SUMMARY and the like.
  let depth = 0;
  for (const line of lines) {
    const t = line.trim().toUpperCase();
    if (t === "BEGIN:VEVENT") {
      if (props !== undefined) return { error: "an event begins inside another" };
      props = [];
      depth = 0;
      continue;
    }
    if (props === undefined) continue;
    if (t.startsWith("BEGIN:")) {
      depth++;
      continue;
    }
    if (t === "END:VEVENT" && depth === 0) {
      const ev = toEvent(props);
      if (ev === undefined) return { error: "an event has no readable DTSTART" };
      events.push(ev);
      props = undefined;
      continue;
    }
    if (t.startsWith("END:")) {
      depth--;
      continue;
    }
    if (depth === 0) {
      const p = property(line);
      if (p !== undefined) props.push(p);
    }
  }
  if (props !== undefined) return { error: "an event is never closed (no END:VEVENT)" };
  return { events };
}

function toEvent(props: readonly Prop[]): IcsEvent | undefined {
  const get = (n: string) => props.find((p) => p.name === n);
  const startProp = get("DTSTART");
  const start = startProp === undefined ? undefined : when(startProp);
  if (start === undefined) return undefined;
  const endProp = get("DTEND");
  const end = endProp === undefined ? undefined : when(endProp);
  let endText = end?.text ?? "";
  if (start.dateOnly) {
    // DTEND of a date is exclusive: show the last day, and nothing for one day.
    const last = end?.dateOnly ? end.day - 1 : undefined;
    endText = last !== undefined && last > start.day ? isoDay(last) : "";
  }
  return {
    start: start.text,
    end: endText,
    allDay: start.dateOnly,
    summary: unescapeText(get("SUMMARY")?.value ?? ""),
    location: unescapeText(get("LOCATION")?.value ?? ""),
  };
}

export function ics(input: RenderInput): Rendered {
  const cal = parseIcs(new TextDecoder().decode(input.body));
  if ("error" in cal) return { content: html``, lines: 0, fallback: `This file is not drawn as a calendar: ${cal.error}.` };
  if (cal.events.length === 0) return { content: html``, lines: 0, fallback: "This calendar holds no events." };
  let rows = "";
  for (const e of cal.events.slice(0, EVENT_CAP)) {
    const end = escapeHtml(e.end);
    const start = e.allDay ? `${escapeHtml(e.start)} <span class="muted">all day</span>` : escapeHtml(e.start);
    rows += `<tr><td>${start}</td><td>${end}</td><td>${escapeHtml(e.summary).replace(/\n/g, "<br>")}</td><td>${escapeHtml(e.location).replace(/\n/g, "<br>")}</td></tr>`;
  }
  const more =
    cal.events.length > EVENT_CAP
      ? `<p class="muted small">Showing ${EVENT_CAP.toLocaleString()} of ${cal.events.length.toLocaleString()} events, ${(cal.events.length - EVENT_CAP).toLocaleString()} more. The rest is in the raw file.</p>`
      : "";
  const name = input.path.slice(input.path.lastIndexOf("/") + 1);
  const content = html`<table class="table" data-dense aria-label="${name} events">
    <thead><tr><th scope="col">Start</th><th scope="col">End</th><th scope="col">Summary</th><th scope="col">Location</th></tr></thead>
    <tbody>${raw(rows)}</tbody>
  </table>${raw(more)}`;
  const n = cal.events.length;
  return { content, lines: 0, summary: `${n.toLocaleString()} ${n === 1 ? "event" : "events"} · ${fileSize(input.size)}` };
}
