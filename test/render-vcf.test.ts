/** Contacts files as a list of people: folding, many cards, FN only, hostile text, caps, a bad file. */
import { describe, expect, test } from "bun:test";
import { fileKind, RENDER_CAP } from "../src/web/render/kinds.ts";
import { RENDERERS, rendererFor } from "../src/web/render/renderers.ts";
import { vcf } from "../src/web/render/vcf.ts";
import { CARD_CAP, parseVcf } from "../src/web/render/vcf-parse.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const draw = (text: string) => vcf({ path: "a/people.vcf", size: text.length, body: enc(text), media: "/m", download: "/d" });
const card = (...l: string[]) => `BEGIN:VCARD\r\nVERSION:3.0\r\n${l.join("\r\n")}\r\nEND:VCARD\r\n`;
const html = (r: ReturnType<typeof vcf>): string => String(r.content);

describe("contacts files", () => {
  test("the registry names .vcf and .vcard and a renderer draws them", () => {
    expect(fileKind("x/a.VCF", enc("BEGIN:VCARD\n"))).toBe("contacts");
    expect(fileKind("a.vcard", enc("BEGIN:VCARD\n"))).toBe("contacts");
    expect(RENDERERS.contacts).toBe(vcf);
  });

  test("folding, many cards, FN only, escapes", () => {
    const r = parseVcf(
      card("FN:Ada Lovelace", "N:Lovelace;Ada;;;", "ORG:Analytical\\, Ltd;Dept", "EMAIL;TYPE=work:ada@example.com", "TEL;TYPE=cell:+1 555 0100", "NOTE:long\r\n  folded\\nline2") +
        card("FN:Only Name") +
        card("N:Hopper;Grace;;Rear Admiral;"),
    );
    if ("error" in r) throw new Error(r.error);
    expect(r.total).toBe(3);
    expect(r.cards[0]).toEqual({ name: "Ada Lovelace", org: "Analytical, Ltd, Dept", emails: ["ada@example.com"], phones: ["+1 555 0100"], urls: [], note: "long folded\nline2" });
    expect(r.cards[1]!.name).toBe("Only Name");
    expect(r.cards[2]!.name).toBe("Rear Admiral Grace Hopper");
  });

  test("hostile fields render as text, never markup or links", () => {
    const out = html(draw(card("FN:<img src=x onerror=alert(1)>", "URL:javascript:alert(1)", "NOTE:<script>alert(2)</script>", "EMAIL:a<b>@x")));
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>");
    expect(out).not.toContain("<a ");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("javascript:alert(1)");
  });

  test("past the cap, a named 'showing first' line and a full count", () => {
    const big = Array.from({ length: CARD_CAP + 3 }, (_, i) => card(`FN:P${i}`)).join("");
    const r = draw(big);
    expect(html(r)).toContain(`Showing first ${CARD_CAP} of ${CARD_CAP + 3} contacts`);
    expect(html(r)).not.toContain(`P${CARD_CAP}<`);
    expect(r.summary).toContain(`${CARD_CAP + 3} contacts`);
  });

  test("urls and notes are labelled apart, under the name, in rows not a wide table", () => {
    const out = html(draw(card("FN:Ada", "EMAIL:a@x.org", "TEL:123", "URL:http://x.org", "NOTE:hi")));
    for (const label of ["Email", "Phone", "Web", "Note"]) expect(out).toContain(`<dt>${label}</dt>`);
    expect(out).not.toContain("<table");
  });

  test("past the size cap the renderer is not used and the source shows", () => {
    const blob = (size: number) => ({ kind: "text", body: enc("BEGIN:VCARD\nFN:A\nEND:VCARD\n"), size, oid: "0".repeat(40) }) as never;
    expect(rendererFor("a.vcf", blob(RENDER_CAP.contacts))?.render).toBe(vcf);
    expect(rendererFor("a.vcf", blob(RENDER_CAP.contacts + 1))).toBeUndefined();
  });

  test("a file that is not contacts falls back to source", () => {
    expect(draw("hello").fallback).toContain("BEGIN:VCARD");
    expect(draw("BEGIN:VCARD\nFN:Unclosed\n").fallback).toContain("no complete cards");
  });
});
