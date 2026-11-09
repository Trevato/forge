/** .patch and .diff drawn as the pull page's diff. */
import { describe, expect, test } from "bun:test";
import { patch, VALUE_CAP } from "../src/web/render/patch.ts";
import { rendererFor } from "../src/web/render/renderers.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const draw = (text: string) => patch({ path: "x.patch", size: text.length, body: enc(text), media: "/m" });

const DIFF = `diff --git a/one.txt b/one.txt
index 1111111..2222222 100644
--- a/one.txt
+++ b/one.txt
@@ -1,2 +1,2 @@
 keep
-old line
+<img src=x onerror=alert(1)>
diff --git a/two.txt b/two.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/two.txt
@@ -0,0 +1 @@
+hello
`;
const MAIL = `From 0123456789abcdef0123456789abcdef01234567 Mon Sep 17 00:00:00 2001
From: Ann <ann@example.com>
Date: Mon, 1 Jan 2024 00:00:00 +0000
Subject: [PATCH] <b>Fix</b> it

body text

---
 one.txt | 2 +-
 1 file changed

${DIFF}`;

describe("patch renderer", () => {
  test("a two-file patch has both files, hunks and marked lines", () => {
    const r = draw(DIFF);
    const out = String(r.content);
    expect(r.fallback).toBeUndefined();
    expect(out).toContain("one.txt");
    expect(out).toContain("two.txt");
    expect(out).toContain("2</strong> files");
    expect(out).toMatch(/class="[^"]*\badd\b/);
    expect(out).toMatch(/class="[^"]*\bdel\b/);
  });
  test("markup in a line arrives escaped", () => {
    const out = String(draw(DIFF).content);
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });
  test("a format-patch header shows From and Subject, escaped", () => {
    const out = String(draw(MAIL).content);
    expect(out).toContain("<dt class=\"muted\">From</dt><dd>Ann &lt;ann@example.com&gt;</dd>");
    expect(out).toContain("<dt class=\"muted\">Subject</dt><dd>[PATCH] &lt;b&gt;Fix&lt;/b&gt; it</dd>");
    expect(out).not.toContain("patch-mail");
    expect(out).not.toContain("<b>Fix");
    expect(out.indexOf("status-rows")).toBeLessThan(out.indexOf("one.txt"));
  });
  test("a 600-character Subject keeps exactly the first 500 characters of its value", () => {
    const subject = "s".repeat(VALUE_CAP) + "TAIL".repeat(25);
    const out = String(draw(MAIL.replace("[PATCH] <b>Fix</b> it", subject)).content);
    expect(out).toContain(`<dt class="muted">Subject</dt><dd>${"s".repeat(VALUE_CAP)}</dd>`);
    expect(out).not.toContain("TAIL");
  });
  test("a mail header with no diff after it falls back", () => {
    expect(draw(MAIL.slice(0, MAIL.indexOf("diff --git"))).fallback).toBeDefined();
  });
  test("text that is not a diff falls back", () => {
    expect(draw("just some notes\n").fallback).toBeDefined();
  });
  test("the blob page picks it for .patch and .diff only", () => {
    for (const name of ["a.patch", "b.DIFF"])
      expect(rendererFor(name, { kind: "text", body: enc(DIFF), size: DIFF.length } as never)).toBeDefined();
    expect(rendererFor("a.txt", { kind: "text", body: enc(DIFF), size: DIFF.length } as never)).toBeUndefined();
  });
});

describe("the committed fixture", () => {
  test("test/fixtures/format-patch.patch draws its header and both files", async () => {
    const text = await Bun.file(new URL("./fixtures/format-patch.patch", import.meta.url)).text();
    const r = draw(text);
    const out = String(r.content);
    expect(r.fallback).toBeUndefined();
    expect(out).toContain("Greet by name, and add a notes file");
    expect(out).toContain("greet.ts");
    expect(out).toContain("notes.md");
    expect(out).not.toContain("<b>names");
  });
});
