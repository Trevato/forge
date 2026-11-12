/** HAR files as a request waterfall: a fixture by hand, a bad file, hostile text, the row cap. */
import { describe, expect, test } from "bun:test";
import { harTable } from "../src/tui/screens/workspace.ts";
import { har, HEADER_CAP, parseHar, ROW_CAP } from "../src/web/render/har.ts";
import { fileKind } from "../src/web/render/kinds.ts";
import { RENDERERS } from "../src/web/render/renderers.ts";
import { content } from "../src/web/style/content.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const draw = (text: string) => har({ path: "a/s.har", size: text.length, body: enc(text), media: "/m", download: "/d" });
const entry = (url: string, start: string, time: number, extra: object = {}) => ({
  startedDateTime: start,
  time,
  request: { method: "get", url, headers: [{ name: "Accept", value: "*/*" }] },
  response: { status: 200, statusText: "OK", content: { size: 2048 }, bodySize: 100, headers: [] },
  ...extra,
});
const file = (...entries: object[]) => JSON.stringify({ log: { version: "1.2", entries } });

describe("HAR files", () => {
  test("the registry names .har and a renderer draws it", () => {
    expect(fileKind("x/a.HAR", enc("{}"))).toBe("har");
    expect(RENDERERS.har).toBe(har);
  });

  test("rows carry method, status, size, time and a bar on the shared timeline", () => {
    const r = draw(file(entry("https://a.test/", "2026-01-01T00:00:00.000Z", 250), entry("https://a.test/x.js", "2026-01-01T00:00:00.500Z", 500)));
    expect(r.fallback).toBeUndefined();
    expect(r.summary).toContain("2 requests");
    const out = String(r.content);
    expect(out).toContain("<td>GET</td>");
    expect(out).toContain("250 ms");
    expect(out).toContain("2.0 KB");
    // span is 1000 ms of 200 units: the second bar starts at 100 and is 100 wide.
    expect(out).toContain('x="100.00" y="0" width="100.00"');
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain('x="0.00" y="0" width="50.00"');
    expect(out).not.toContain("<script");
  });

  test("a malformed file falls back to source with a reason", () => {
    expect(draw("{not json").fallback).toContain("not valid JSON");
    expect(draw("{}").fallback).toContain("log.entries");
    expect(draw(file()).fallback).toContain("no requests");
    expect(parseHar("[1]")).toEqual({ error: "it has no log.entries list" });
  });

  test("a script tag in a URL or header is text, never markup", () => {
    const bad = "https://x.test/<script>alert(1)</script>";
    const e = entry(bad, "2026-01-01T00:00:00Z", 1);
    (e.request.headers as object[]).push({ name: "X<b>", value: '"><img src=x onerror=alert(1)>' });
    const out = String(draw(file(e)).content);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
  });

  test("unknown size and no response are shown plainly", () => {
    const e = entry("https://a.test/", "2026-01-01T00:00:00Z", 5, { response: { status: 0, content: { size: -1 }, bodySize: -1 } });
    const out = String(draw(file(e)).content);
    expect(out).toContain("<td>GET</td><td>—</td>");
    expect(out).toContain("</td><td>—</td><td>5 ms</td>");
  });

  test("over the header cap, the rest is counted in words", () => {
    const e = entry("https://a.test/", "2026-01-01T00:00:00Z", 1);
    e.request.headers = Array.from({ length: HEADER_CAP + 4 }, (_, i) => ({ name: `X-H${i}`, value: "v" }));
    const out = String(draw(file(e)).content);
    expect(out.match(/<li>/g)?.length).toBe(HEADER_CAP);
    expect(out).toContain(`X-H${HEADER_CAP - 1}`);
    expect(out).not.toContain(`X-H${HEADER_CAP}<`);
    expect(out).toContain("4 more headers not shown.");
  });

  test("a field over 2,000 characters is cut at 2,000", () => {
    const long = `https://a.test/${"a".repeat(3000)}`;
    const parsed = parseHar(file(entry(long, "2026-01-01T00:00:00Z", 1)));
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.entries[0]!.url.length).toBe(2000);
    const out = String(draw(file(entry(long, "2026-01-01T00:00:00Z", 1))).content);
    expect(out).toContain(`https://a.test/${"a".repeat(1985)}<`);
    expect(out).not.toContain("a".repeat(1986));
  });

  test("a script tag in the status text is escaped", () => {
    const e = entry("https://a.test/", "2026-01-01T00:00:00Z", 1);
    e.response.statusText = "<script>alert(1)</script>";
    const out = String(draw(file(e)).content);
    expect(out).not.toContain("<script");
    expect(out).toContain('<span class="muted">&lt;script&gt;alert(1)&lt;/script&gt;</span>');
  });

  test("over the row cap, rows are cut and the count says how many", () => {
    const many = Array.from({ length: ROW_CAP + 3 }, (_, i) => entry(`https://a.test/${i}`, "2026-01-01T00:00:00Z", 1));
    const out = String(draw(file(...many)).content);
    expect(out.match(/<tr>/g)?.length).toBe(ROW_CAP + 1);
    expect(out).toContain("3 left out");
  });

  test("the terminal door draws no table for a malformed HAR, so the workspace shows its source", () => {
    // null is the workspace's signal to fall back to the source view (src/tui/screens/workspace.ts).
    expect(harTable('{"log": {"entries": [1, ')).toBeNull();
    expect(harTable("not json")).toBeNull();
    expect(harTable(file())).toBeNull();
    const t = harTable(file(entry("https://a.test/", "2026-01-01T00:00:00Z", 1)));
    expect(t?.header).toEqual(["Method", "Status", "URL", "Size", "Time"]);
    expect(t?.rows[0]?.slice(0, 3)).toEqual(["GET", "200", "https://a.test/"]);
  });
});

test("the timing bar is data, so it is drawn in a quiet colour, never the accent (DESIGN principle 5)", () => {
  const rule = content.match(/\.har-view \.har-bar \{[^}]*\}/)?.[0] ?? "";
  expect(rule).toContain("color: var(--muted-fg)");
  expect(rule).not.toContain("--accent");
});
