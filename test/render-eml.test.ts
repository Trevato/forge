/** Mail files as a message: headers, bodies, encodings, attachments, html-only, hostile text, a bad file. */
import { describe, expect, test } from "bun:test";
import { eml } from "../src/web/render/eml.ts";
import { parseEml } from "../src/web/render/eml-parse.ts";
import { fileKind, RENDER_CAP } from "../src/web/render/kinds.ts";
import { RENDERERS, rendererFor } from "../src/web/render/renderers.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const draw = (text: string | Uint8Array) => {
  const body = typeof text === "string" ? enc(text) : text;
  return eml({ path: "a/mail.eml", size: body.length, body, media: "/m", download: "/d" });
};
const out = (r: ReturnType<typeof eml>): string => String(r.content);
const crlf = (s: string): string => s.replace(/\n/g, "\r\n");

describe("mail files", () => {
  test("the registry names .eml, capped at 5 MB, and a renderer draws it", () => {
    expect(fileKind("x/a.EML", enc("From: a@b.c\n\nhi"))).toBe("mail");
    expect(RENDER_CAP.mail).toBe(5_000_000);
    expect(RENDERERS.mail).toBe(eml);
  });

  test("a plain message shows its rows and body", () => {
    const r = draw(crlf("From: Ada <ada@x.org>\nTo: Bob <bob@x.org>\nCc: Cy <cy@x.org>\nSubject: Hi\nDate: Mon, 1 Jan 2026 10:00:00 +0000\n\nHello,\nworld\n"));
    const html = out(r);
    for (const label of ["From", "To", "Cc", "Subject", "Date"]) expect(html).toContain(`<dt>${label}</dt>`);
    expect(html).toContain("Ada &lt;ada@x.org&gt;");
    expect(html).toContain("<pre>Hello,\nworld</pre>");
    expect(r.fallback).toBeUndefined();
  });

  test("folded and encoded headers", () => {
    const m = parseEml(enc("From: a@b.c\nSubject: one\n two\n\t=?UTF-8?Q?caf=C3=A9_?= =?iso-8859-1?B?6Q==?=\nTo: =?utf-8?B?w6k=?= <e@x.org>\n\nx"));
    if ("error" in m) throw new Error(m.error);
    expect(m.headers.find((h) => h[0] === "Subject")![1]).toBe("one two café é");
    expect(m.headers.find((h) => h[0] === "To")![1]).toBe("é <e@x.org>");
  });

  test("quoted-printable and base64 bodies, utf-8 and latin-1", () => {
    const qp = parseEml(enc("Subject: a\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\ncaf=C3=A9 soft=\nbreak\n"));
    if ("error" in qp) throw new Error(qp.error);
    expect(qp.body).toBe("café softbreak");
    const lat = parseEml(enc("Subject: a\nContent-Type: text/plain; charset=iso-8859-1\nContent-Transfer-Encoding: quoted-printable\n\ncaf=E9\n"));
    if ("error" in lat) throw new Error(lat.error);
    expect(lat.body).toBe("café");
    const u = parseEml(enc(`Subject: a\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: base64\n\n${Buffer.from("héllo ✓").toString("base64")}\n`));
    if ("error" in u) throw new Error(u.error);
    expect(u.body).toBe("héllo ✓");
  });

  test("multipart: first text/plain, attachments by name, type and size", () => {
    const file = Buffer.from("x".repeat(2048)).toString("base64");
    const r = draw(
      crlf(
        `From: a@b.c\nSubject: s\nMIME-Version: 1.0\nContent-Type: multipart/mixed; boundary="BB"\n\n--BB\nContent-Type: multipart/alternative; boundary=AA\n\n--AA\nContent-Type: text/plain\n\nPlain part\n--AA\nContent-Type: text/html\n\n<p>Html part</p>\n--AA--\n--BB\nContent-Type: application/pdf; name="report.pdf"\nContent-Disposition: attachment; filename="report.pdf"\nContent-Transfer-Encoding: base64\n\n${file}\n--BB--\n`,
      ),
    );
    const html = out(r);
    expect(html).toContain("Plain part");
    expect(html).not.toContain("Html part");
    expect(html).toContain("<dt>report.pdf</dt>");
    expect(html).toContain("application/pdf · 2.0 KB");
    expect(r.summary).toContain("1 attachment");
  });

  test("a boundary line with trailing spaces still splits; a headerless part is plain text", () => {
    const m = parseEml(enc('From: a@b.c\nContent-Type: multipart/mixed; boundary="BB"\n\n--BB  \n\nno headers here\n--BB \t\nContent-Type: text/html\n\n<p>x</p>\n--BB--  \n'));
    if ("error" in m) throw new Error(m.error);
    expect(m.body).toBe("no headers here");
    expect(m.attachments).toEqual([]);
  });

  test("the message body sits in a wrapping box", () => {
    expect(out(draw("From: a@b.c\n\nhello"))).toContain('<div class="prose" data-text="message"><pre>hello</pre></div>');
  });

  test("html-only shows its text with tags stripped and says so; html is never rendered", () => {
    const r = draw("From: a@b.c\nSubject: s\nContent-Type: text/html\n\n<style>p{}</style><p onclick=x>Hi &amp; bye</p><script>alert(1)</script><br>there");
    const html = out(r);
    expect(html).toContain("Hi &amp; bye");
    expect(html).toContain("tags stripped");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("alert(1)");
  });

  test("a <script> in Subject is escaped", () => {
    const html = out(draw("From: a@b.c\nSubject: <script>alert(1)</script>\n\nbody <img src=x onerror=y>\n"));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  test("a malformed file falls back to the source with the reason", () => {
    for (const bad of ["", "just some prose\nwith no headers", "\u0001\u0002binary"]) {
      const r = draw(bad);
      expect(r.fallback).toContain("not drawn as a message");
    }
    expect(draw("X-Thing: 1\n\nbody").fallback).toContain("none of From");
  });

  test("past the size cap the renderer is not used", () => {
    const blob = (size: number) => ({ kind: "text", body: enc("From: a@b.c\n\nhi"), size, oid: "0".repeat(40) }) as never;
    expect(rendererFor("a.eml", blob(RENDER_CAP.mail))?.render).toBe(eml);
    expect(rendererFor("a.eml", blob(RENDER_CAP.mail + 1))).toBeUndefined();
  });
});
