import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CARD_HEIGHT, CARD_WIDTH, CARD_KINDS, renderCard, type CardInput } from "../src/web/og/card.ts";
import { fit } from "../src/web/og/xml.ts";
import { rasterizer } from "../src/web/og/raster.ts";
import { Resvg } from "../src/web/og/vendor/resvg.mjs";

const LONG =
  "A very long sentence about what this thing does and why anybody would ever want to read all of it on a share card";
const SRC = "data:image/png;base64,iVBORw0KGgo=";
const VENDOR = join(import.meta.dir, "../src/web/og/vendor");
const PAD = 80;
const COLUMN_RIGHT = PAD + 620;

const fonts = await Promise.all(
  ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSansMono.ttf", "DejaVuSansMono-Bold.ttf"].map(
    async (f) => new Uint8Array(await Bun.file(join(VENDOR, f)).arrayBuffer()),
  ),
);

function inputs(kind: (typeof CARD_KINDS)[number]): { input: CardInput; right: number }[] {
  const shapes: CardInput[] = [
    { kind, title: "Fast forge", lines: ["one", "two"], stat: "12 open" },
    { kind, title: LONG + " " + LONG, tagline: LONG, lines: [LONG, LONG, LONG], stat: LONG },
    { kind, title: "x".repeat(300), lines: ["y".repeat(300)], stat: "z".repeat(300) },
    // Wide glyphs, where an average-width estimate is tightest.
    { kind, title: "WMWM ".repeat(30), tagline: "MMMM WWWW 0123456789".repeat(4), lines: ["W".repeat(80), "0123456789 ".repeat(20), "@%mw".repeat(30)], stat: "WWWW MMMM 0000 ".repeat(8) },
  ];
  return [
    ...shapes.map((input) => ({ input, right: CARD_WIDTH - PAD })),
    ...shapes.map((input) => ({ input: { ...input, images: [{ id: "a", src: SRC }] }, right: COLUMN_RIGHT })),
  ];
}

function pngSize(png: Uint8Array): [number, number] {
  const v = new DataView(png.buffer, png.byteOffset);
  return [v.getUint32(16), v.getUint32(20)];
}

describe("og cards as images", () => {
  for (const kind of CARD_KINDS) {
    test(`${kind}: rendered 1200×630, no text box leaves its margins`, async () => {
      const raster = await rasterizer();
      for (const { input, right } of inputs(kind)) {
        const svg = renderCard(input);
        const png = raster(svg);
        expect(Array.from(png.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
        expect(pngSize(png)).toEqual([CARD_WIDTH, CARD_HEIGHT]);
        const head = svg.slice(0, svg.indexOf(">") + 1);
        let boxes = 0;
        for (const m of svg.matchAll(/<text [^>]*>[^<]*<\/text>/g)) {
          const r = new Resvg(`${head}${m[0]}</svg>`, {
            font: {
              fontBuffers: fonts,
              loadSystemFonts: false,
              defaultFontFamily: "DejaVu Sans",
              sansSerifFamily: "DejaVu Sans",
              monospaceFamily: "DejaVu Sans Mono",
            },
          });
          const box = r.innerBBox();
          r.free();
          if (!box) continue;
          boxes++;
          const x = Number(m[0].match(/ x="(\d+)"/)![1]);
          const tolerance = x === PAD ? 4 : 0; // the logo word sits right of the mark
          expect(box.x).toBeGreaterThanOrEqual(x - tolerance);
          expect(box.x + box.width).toBeLessThanOrEqual(x === PAD ? right : CARD_WIDTH - PAD);
          expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.y + box.height).toBeLessThanOrEqual(CARD_HEIGHT);
        }
        expect(boxes).toBeGreaterThan(2);
      }
    });
  }
});

describe("fit cuts at a word", () => {
  test("no separator is left dangling before the ellipsis", () => {
    for (const sep of ["·", "|", "/", "•", "-", ","]) {
      const out = fit(`lab--9628--forge.example.sh ${sep} open source and more`, 32, 560, 0.62);
      expect(out.endsWith("…")).toBe(true);
      expect(out.slice(0, -1)).toMatch(/[A-Za-z0-9]$/);
    }
    expect(fit("host.example.sh · open source", 32, 32 * 0.62 * 19)).toBe("host.example.sh…");
  });
  test("a long sentence ends in an ellipsis after a whole word", () => {
    const out = fit(LONG, 30, 400);
    expect(out.endsWith("…")).toBe(true);
    for (const w of out.slice(0, -1).split(" ")) expect(LONG.split(" ")).toContain(w);
  });
  test("one word wider than the box is cut with an ellipsis", () => {
    expect(fit("x".repeat(100), 30, 300).endsWith("…")).toBe(true);
  });
});
