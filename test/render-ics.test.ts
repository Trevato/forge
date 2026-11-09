/** Calendar files as a list of events: folding, all-day, TZID, escapes, hostile text, a bad file. */
import { describe, expect, test } from "bun:test";
import { EVENT_CAP, ics, parseIcs } from "../src/web/render/ics.ts";
import { fileKind } from "../src/web/render/kinds.ts";
import { RENDERERS } from "../src/web/render/renderers.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const draw = (text: string) => ics({ path: "a/cal.ics", size: text.length, body: enc(text), media: "/m" });
const wrap = (...events: string[]) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.map((e) => `BEGIN:VEVENT\r\n${e}\r\nEND:VEVENT\r\n`).join("")}END:VCALENDAR\r\n`;

describe("calendar files", () => {
  test("the registry names .ics and a renderer draws it", () => {
    expect(fileKind("x/a.ICS", enc("BEGIN:VCALENDAR\n"))).toBe("calendar");
    expect(RENDERERS.calendar).toBe(ics);
  });

  test("folded lines, escapes, UTC and TZID times, in file order", () => {
    const cal = parseIcs(
      wrap(
        "DTSTART:20260301T090000Z\r\nDTEND:20260301T100000Z\r\nSUMMARY:Plan\\, build\\nand a very long\r\n  title folded\r\nLOCATION:Room 1\\; East",
        "DTSTART;TZID=Europe/Paris:20260302T140000\r\nDTEND;TZID=Europe/Paris:20260302T150000\r\nSUMMARY:Second",
      ),
    );
    expect(cal).toEqual({
      events: [
        { start: "2026-03-01 09:00 UTC", end: "2026-03-01 10:00 UTC", allDay: false, summary: "Plan, build\nand a very long title folded", location: "Room 1; East" },
        { start: "2026-03-02 14:00 Europe/Paris", end: "2026-03-02 15:00 Europe/Paris", allDay: false, summary: "Second", location: "" },
      ],
    });
  });

  test("all-day events: the exclusive end becomes the last day", () => {
    const cal = parseIcs(
      wrap(
        "DTSTART;VALUE=DATE:20260301\r\nDTEND;VALUE=DATE:20260302\r\nSUMMARY:One day",
        "DTSTART;VALUE=DATE:20260228\r\nDTEND;VALUE=DATE:20260303\r\nSUMMARY:Span",
      ),
    );
    if ("error" in cal) throw new Error(cal.error);
    expect(cal.events.map((e) => [e.allDay, e.start, e.end])).toEqual([
      [true, "2026-03-01", ""],
      [true, "2026-02-28", "2026-03-02"],
    ]);
    const out = String(draw(wrap("DTSTART;VALUE=DATE:20260301\r\nSUMMARY:X")).content);
    expect(out).toContain("all day");
  });

  test("a nested VALARM does not overwrite the event's summary", () => {
    const cal = parseIcs(wrap("DTSTART:20260301T090000\r\nSUMMARY:Real\r\nBEGIN:VALARM\r\nSUMMARY:Alarm\r\nEND:VALARM"));
    if ("error" in cal) throw new Error(cal.error);
    expect(cal.events[0]!.summary).toBe("Real");
  });

  test("a <script> summary is escaped, never emitted", () => {
    const r = draw(wrap("DTSTART:20260301T090000Z\r\nSUMMARY:<script>alert(1)</script>\r\nLOCATION:\"><img src=x onerror=1>"));
    const out = String(r.content);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
    expect(r.summary).toContain("1 event");
  });

  test("malformed files fall back to text", () => {
    expect(draw("just some words").fallback).toBeDefined();
    expect(draw("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20260301\r\n").fallback).toContain("never closed");
    expect(draw(wrap("SUMMARY:no start")).fallback).toContain("DTSTART");
    expect(draw(wrap("DTSTART:20261399T000000Z\r\nSUMMARY:bad")).fallback).toBeDefined();
    expect(draw("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n").fallback).toContain("no events");
  });

  test("capped at 500 events, saying how many more", () => {
    const many = Array.from({ length: EVENT_CAP + 7 }, (_, i) => `DTSTART:20260301T090000Z\r\nSUMMARY:e${i}`);
    const out = String(draw(wrap(...many)).content);
    expect(out).toContain("e499<");
    expect(out).not.toContain("e500<");
    expect(out).toContain("7 more");
  });
});
