/** Subtitle files as a transcript: SRT, VTT, hostile text, a bad cue. */
import { describe, expect, test } from "bun:test";
import { parseSubtitles, subtitles } from "../src/web/render/subtitles.ts";
import { fileKind } from "../src/web/render/kinds.ts";
import { RENDERERS } from "../src/web/render/renderers.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const draw = (text: string, path = "a.srt") =>
  subtitles({ path, size: text.length, body: enc(text), media: "/m", download: "/d" });
const html = (text: string, path?: string): string => String(draw(text, path).content);

const SRT = "1\r\n00:00:01,500 --> 00:00:03,000\r\nHello <i>there</i>\r\n\r\n2\r\n01:02:03,004 --> 01:02:05,000\r\n{\\an8}Line one\r\nLine two\r\n";
const VTT = `WEBVTT - demo

NOTE a comment

00:01.250 --> 00:03.000 align:start
<v Ann>Hi <00:02.000>again</v>

intro
00:01:00.000 --> 00:01:02.000
Bye
`;

describe("subtitle files", () => {
  test("the registry names .srt and .vtt and a renderer draws them", () => {
    expect(fileKind("x/a.srt", enc(SRT))).toBe("subtitles");
    expect(fileKind("x/a.VTT", enc(VTT))).toBe("subtitles");
    expect(RENDERERS.subtitles).toBe(subtitles);
  });

  test("an SRT: start times and text, tags stripped", () => {
    const t = parseSubtitles(SRT);
    expect(t.failures).toEqual([]);
    expect(t.cues).toEqual([
      { start: "00:00:01.500", text: "Hello there" },
      { start: "01:02:03.004", text: "Line one\nLine two" },
    ]);
    const out = html(SRT);
    expect(out).toContain("<time>00:00:01.500</time>");
    expect(out).toContain("Line one<br>Line two");
    expect(out).not.toContain("<i>");
    expect(draw(SRT).summary).toContain("2 cues");
  });

  test("a VTT: header, NOTE and ids skipped, hour optional, voice tags stripped", () => {
    const t = parseSubtitles(VTT);
    expect(t.failures).toEqual([]);
    expect(t.cues).toEqual([
      { start: "00:01.250", text: "Hi again" },
      { start: "00:01:00.000", text: "Bye" },
    ]);
  });

  test("a cue containing <script> is escaped, never emitted", () => {
    const out = html("1\n00:00:01,000 --> 00:00:02,000\n&<script>alert(1)</script>x &lt;b&gt;\n");
    expect(out).not.toContain("<script");
    const lone = html("1\n00:00:01,000 --> 00:00:02,000\n1 < 2 && 3 > 2\n");
    expect(lone).toContain("1 &lt; 2 &amp;&amp; 3 &gt; 2");
    expect(out).toContain("&amp;");
    expect(out).toContain("&amp;lt;b&amp;gt;");
  });

  test("a malformed cue is named and the rest still renders", () => {
    const src = "1\n00:00:01,000 --> 00:00:02,000\nOne\n\n2\n00:00:0x --> nope\nBroken\n\n3\njust words\n\n4\n00:00:09,000 --> 00:00:10,000\nFour\n";
    const t = parseSubtitles(src);
    expect(t.cues.map((c) => c.text)).toEqual(["One", "Four"]);
    expect(t.failures.map((f) => [f.name, f.line])).toEqual([["2", 6], ["3", 9]]);
    const out = html(src);
    expect(out).toContain("2 cues could not be read, first is cue 2 (line 6)");
    expect(out).toContain("check the arrow line");
    // One summary line, below the table, in a bare table (no card).
    expect(out.indexOf("could not be read")).toBeGreaterThan(out.indexOf("</table>"));
    expect(out).not.toContain("card");
    expect(out).toContain("Four");
  });

  test("a file with no cues falls back to source", () => {
    expect(draw("").fallback).toBeDefined();
  });
});
