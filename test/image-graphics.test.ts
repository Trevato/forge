/**
 * Terminal graphics: what we claim a session can do, and the bytes we send.
 *
 * Escape sequences are asserted by *parsing them back*, never by substring
 * matching. Both halves of this file contain a small reader — an APC splitter
 * for the kitty protocol and a real sixel interpreter — so a test says "this
 * is what a terminal would understand from what we wrote", which is the only
 * claim worth making. Matching `"a=T"` in a blob proves the string is in
 * there; it does not prove the sequence is well formed, correctly chunked, or
 * decodable back to the picture.
 */

import { describe, expect, test } from "bun:test";
import {
  decode,
  sniff,
  thumbnail,
  MAX_PIXELS,
} from "../src/design/image/image.ts";
import {
  KITTY_CHUNK,
  capabilitiesFor,
  graphicsFromTerm,
  iconsFromTerm,
  itermImage,
  kittyDelete,
  kittyImage,
  parseGraphicsSetting,
  parseIconSetting,
  quantize,
  sixelImage,
} from "../src/tui/term/graphics.ts";
import {
  headlessTerminal,
  terminalCapabilities,
} from "../src/tui/term/terminal.ts";
import { Screen } from "../src/tui/term/screen.ts";
import { theme } from "../src/tui/ui/theme.ts";
import {
  clearImages,
  drawImage,
  humanBytes,
  placeholderLines,
  placementSize,
  prepareImage,
} from "../src/tui/ui/image.ts";

const decoder = new TextDecoder();
const FIXTURES = `${import.meta.dir}/fixtures`;
const C = theme("dark").c;

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(`${FIXTURES}/${name}`).arrayBuffer());
}

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

describe("capability detection", () => {
  // The whole table, as a table. `TERM` is the only variable SSH forwards, so
  // this is the entire basis on which the feature turns itself on.
  const TABLE: readonly [string | undefined, string, string][] = [
    ["xterm-kitty", "kitty", "nerd"],
    ["xterm-ghostty", "kitty", "nerd"],
    ["ghostty", "kitty", "nerd"],
    ["wezterm", "kitty", "nerd"],
    ["xterm-wezterm", "kitty", "nerd"],
    ["foot", "sixel", "plain"],
    ["foot-extra", "sixel", "plain"],
    ["foot-direct", "sixel", "plain"],
    ["mlterm", "sixel", "plain"],
    ["yaft-256color", "sixel", "plain"],
    // The ones we deliberately refuse to guess about.
    ["xterm-256color", "none", "plain"],
    ["xterm", "none", "plain"],
    ["screen-256color", "none", "plain"],
    ["tmux-256color", "none", "plain"],
    ["alacritty", "none", "plain"],
    ["dumb", "none", "plain"],
    [undefined, "none", "plain"],
    ["", "none", "plain"],
  ];

  for (const [term, graphics, icons] of TABLE)
    test(`TERM=${term ?? "(unset)"} → ${graphics} / ${icons}`, () => {
      expect(graphicsFromTerm(term)).toBe(graphics as never);
      expect(iconsFromTerm(term)).toBe(icons as never);
    });

  test("iTerm2 is invisible to TERM, so only the setting reaches it", () => {
    // iTerm2 reports xterm-256color. Guessing "iterm" from that would paint
    // OSC 1337 into every screen/tmux/Terminal.app session on earth.
    expect(graphicsFromTerm("xterm-256color")).toBe("none");
    const caps = capabilitiesFor({ term: "xterm-256color", graphics: "iterm" });
    expect(caps.graphics).toBe("iterm");
    expect(caps.graphicsFrom).toBe("setting");
  });

  test("an explicit setting beats the guess in both directions", () => {
    expect(
      capabilitiesFor({ term: "xterm-kitty", graphics: "none" }),
    ).toMatchObject({ graphics: "none", graphicsFrom: "setting" });
    expect(capabilitiesFor({ term: "xterm", graphics: "sixel" })).toMatchObject(
      {
        graphics: "sixel",
        graphicsFrom: "setting",
      },
    );
    expect(capabilitiesFor({ term: "xterm", icons: "nerd" })).toMatchObject({
      icons: "nerd",
      iconsFrom: "setting",
    });
    expect(
      capabilitiesFor({ term: "xterm-kitty", icons: "plain" }),
    ).toMatchObject({ icons: "plain", iconsFrom: "setting" });
  });

  test("auto is the same answer as no setting at all", () => {
    const auto = capabilitiesFor({
      term: "xterm-ghostty",
      graphics: "auto",
      icons: "auto",
    });
    const bare = capabilitiesFor({ term: "xterm-ghostty" });
    expect(auto.graphics).toBe(bare.graphics);
    expect(auto.icons).toBe(bare.icons);
    expect(auto.graphicsFrom).toBe("term");
  });

  test("settings parse strictly; anything else falls back to the guess", () => {
    expect(parseGraphicsSetting("kitty")).toBe("kitty");
    expect(parseGraphicsSetting("sixel")).toBe("sixel");
    expect(parseGraphicsSetting("iterm")).toBe("iterm");
    expect(parseGraphicsSetting("none")).toBe("none");
    expect(parseGraphicsSetting("auto")).toBe("auto");
    expect(parseGraphicsSetting("KITTY")).toBeUndefined();
    expect(parseGraphicsSetting("")).toBeUndefined();
    expect(parseGraphicsSetting(undefined)).toBeUndefined();
    expect(parseIconSetting("nerd")).toBe("nerd");
    expect(parseIconSetting("plain")).toBe("plain");
    expect(parseIconSetting("nerdfont")).toBeUndefined();
  });
});

describe("cell geometry", () => {
  test("with no pixel size, the 1:2 guess", () => {
    const caps = capabilitiesFor({ term: "xterm-kitty", cols: 80, rows: 24 });
    expect(caps.cell).toEqual({ width: 10, height: 20, measured: false });
  });

  test("a reported window size measures the cell", () => {
    const caps = capabilitiesFor({
      term: "xterm-kitty",
      cols: 80,
      rows: 24,
      pixelWidth: 1120,
      pixelHeight: 672,
    });
    expect(caps.cell).toEqual({ width: 14, height: 28, measured: true });
  });

  test("zeros and absurd results fall back rather than being trusted", () => {
    // OpenSSH sends 0×0 pixels whenever the client did not measure.
    expect(
      capabilitiesFor({ cols: 80, rows: 24, pixelWidth: 0, pixelHeight: 0 })
        .cell.measured,
    ).toBe(false);
    // A one-pixel-per-cell report is a client sending something else.
    expect(
      capabilitiesFor({ cols: 80, rows: 24, pixelWidth: 80, pixelHeight: 24 })
        .cell.measured,
    ).toBe(false);
    expect(
      capabilitiesFor({
        cols: 80,
        rows: 24,
        pixelWidth: 99999,
        pixelHeight: 99999,
      }).cell.measured,
    ).toBe(false);
  });

  test("the transport supplies TERM and the pixel size", () => {
    const t = headlessTerminal(100, 30, "xterm-ghostty");
    expect(terminalCapabilities(t)).toMatchObject({
      term: "xterm-ghostty",
      graphics: "kitty",
      icons: "nerd",
    });
    expect(terminalCapabilities(t).cell.measured).toBe(false);
    t.setPixelSize(1200, 600);
    const caps = terminalCapabilities(t);
    expect(caps.cell).toEqual({ width: 12, height: 20, measured: true });
    // A preference still wins over everything the transport says.
    expect(terminalCapabilities(t, { graphics: "none" }).graphics).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// kitty
// ---------------------------------------------------------------------------

interface Apc {
  readonly control: Map<string, string>;
  readonly payload: string;
}

/** Split a byte stream into APC graphics sequences, or fail loudly. */
function parseApc(chunks: readonly Uint8Array[]): Apc[] {
  return chunks.map((chunk) => {
    const text = decoder.decode(chunk);
    expect(text.startsWith("\x1b_G")).toBe(true);
    expect(text.endsWith("\x1b\\")).toBe(true);
    const body = text.slice(3, -2);
    const semi = body.indexOf(";");
    const head = semi === -1 ? body : body.slice(0, semi);
    const control = new Map<string, string>();
    for (const pair of head.split(",")) {
      const [k, v] = pair.split("=");
      if (k !== undefined && v !== undefined) control.set(k, v);
    }
    return { control, payload: semi === -1 ? "" : body.slice(semi + 1) };
  });
}

describe("kitty graphics protocol", () => {
  test("a small PNG is one sequence with the documented control keys", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const parts = parseApc(
      kittyImage({
        id: 7,
        format: "png",
        width: 20,
        height: 10,
        data,
        cols: 4,
        rows: 2,
      }),
    );
    expect(parts.length).toBe(1);
    const { control, payload } = parts[0]!;
    expect(control.get("a")).toBe("T"); // transmit and display
    expect(control.get("f")).toBe("100"); // PNG passthrough
    expect(control.get("i")).toBe("7");
    expect(control.get("q")).toBe("2"); // no reply on our input stream
    expect(control.get("C")).toBe("1"); // do not move the cursor
    expect(control.get("c")).toBe("4");
    expect(control.get("r")).toBe("2");
    expect(control.get("m")).toBe("0"); // the last (only) chunk
    // s/v are for raw pixels; a PNG carries its own dimensions.
    expect(control.has("s")).toBe(false);
    expect(control.has("v")).toBe(false);
    expect([...Buffer.from(payload, "base64")]).toEqual([...data]);
  });

  test("raw formats declare their pixel geometry", () => {
    for (const [format, code] of [
      ["rgb", "24"],
      ["rgba", "32"],
    ] as const) {
      const [part] = parseApc(
        kittyImage({
          id: 1,
          format,
          width: 6,
          height: 4,
          data: new Uint8Array(6 * 4 * (format === "rgb" ? 3 : 4)),
          cols: 3,
          rows: 1,
        }),
      );
      expect(part!.control.get("f")).toBe(code);
      expect(part!.control.get("s")).toBe("6");
      expect(part!.control.get("v")).toBe("4");
    }
  });

  test("a large payload chunks at 4096 base64 bytes and reassembles", () => {
    // 12 KB of pixels — several chunks, with a short final one.
    const data = new Uint8Array(12_000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 31) & 0xff;
    const parts = parseApc(
      kittyImage({
        id: 3,
        format: "rgb",
        width: 100,
        height: 40,
        data,
        cols: 10,
        rows: 5,
      }),
    );
    expect(parts.length).toBeGreaterThan(3);

    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      expect(part.payload.length).toBeLessThanOrEqual(KITTY_CHUNK);
      expect(part.control.get("m")).toBe(last ? "0" : "1");
      // Every chunk but the last must be a whole number of base64 groups, or
      // the terminal decodes padding in the middle of the image.
      if (!last) expect(part.payload.length % 4).toBe(0);
      if (i === 0) {
        expect(part.control.get("a")).toBe("T");
        expect(part.control.get("f")).toBe("24");
      } else {
        // Continuation chunks carry only m and q — repeating f, s, v or i on
        // one is a protocol error.
        expect([...part.control.keys()].sort()).toEqual(["m", "q"]);
      }
    }
    const joined = parts.map((p) => p.payload).join("");
    expect([...Buffer.from(joined, "base64")]).toEqual([...data]);
  });

  test("an empty payload is still one well-formed sequence", () => {
    const parts = parseApc(
      kittyImage({
        id: 1,
        format: "png",
        width: 1,
        height: 1,
        data: new Uint8Array(0),
      }),
    );
    expect(parts.length).toBe(1);
    expect(parts[0]!.control.get("m")).toBe("0");
  });

  test("delete frees the data, by id or wholesale", () => {
    expect(decoder.decode(kittyDelete(9))).toBe("\x1b_Ga=d,d=I,i=9,q=2\x1b\\");
    // Uppercase I and A are the forms that release the terminal's memory;
    // the lowercase twins would leak an image per file browsed.
    expect(decoder.decode(kittyDelete())).toBe("\x1b_Ga=d,d=A,q=2\x1b\\");
  });
});

describe("iTerm2 inline images", () => {
  test("one OSC 1337 sequence carrying the whole file", () => {
    const data = new Uint8Array([9, 8, 7]);
    const text = decoder.decode(itermImage(data, { cols: 5, rows: 3 }));
    expect(text.startsWith("\x1b]1337;File=")).toBe(true);
    expect(text.endsWith("\x07")).toBe(true);
    const [args, payload] = text.slice(12, -1).split(":");
    expect(args).toContain("size=3");
    expect(args).toContain("width=5");
    expect(args).toContain("height=3");
    expect(args).toContain("inline=1");
    expect([...Buffer.from(payload!, "base64")]).toEqual([...data]);
  });
});

// ---------------------------------------------------------------------------
// Sixel
// ---------------------------------------------------------------------------

interface Sixel {
  width: number;
  height: number;
  /** Palette index per pixel; -1 where nothing was painted. */
  pixels: Int16Array;
  palette: number[][];
}

/**
 * A real sixel interpreter, so the encoder is checked by decoding it rather
 * than by eyeballing the string. Handles exactly what we emit: the DCS
 * header, raster attributes, RGB colour definitions on the 0–100 scale, the
 * repeat introducer, carriage return and line feed.
 */
function readSixel(bytes: Uint8Array): Sixel {
  const s = decoder.decode(bytes);
  const head = /^\x1bP(\d*);(\d*);(\d*)q/.exec(s);
  expect(head).not.toBeNull();
  let at = head![0].length;
  expect(s.endsWith("\x1b\\")).toBe(true);

  const raster = /^"(\d+);(\d+);(\d+);(\d+)/.exec(s.slice(at));
  expect(raster).not.toBeNull();
  at += raster![0].length;
  const width = Number(raster![3]);
  const height = Number(raster![4]);

  const palette: number[][] = [];
  const pixels = new Int16Array(width * height).fill(-1);
  let color = 0;
  let x = 0;
  let band = 0;
  const body = s.slice(at, s.length - 2);
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === "#") {
      const m = /^#(\d+)(?:;(\d+);(\d+);(\d+);(\d+))?/.exec(body.slice(i))!;
      color = Number(m[1]);
      if (m[2] !== undefined) {
        expect(m[2]).toBe("2"); // RGB, not HLS
        palette[color] = [Number(m[3]), Number(m[4]), Number(m[5])];
      } else {
        x = 0; // selecting a colour for a new pass starts at the left edge
      }
      i += m[0].length;
      continue;
    }
    if (ch === "$") {
      x = 0;
      i++;
      continue;
    }
    if (ch === "-") {
      band++;
      x = 0;
      i++;
      continue;
    }
    let repeat = 1;
    if (ch === "!") {
      const m = /^!(\d+)/.exec(body.slice(i))!;
      repeat = Number(m[1]);
      i += m[0].length;
    }
    const code = body.charCodeAt(i++) - 0x3f;
    expect(code).toBeGreaterThanOrEqual(0);
    expect(code).toBeLessThanOrEqual(63);
    for (let r = 0; r < repeat; r++, x++)
      for (let dy = 0; dy < 6; dy++) {
        if ((code & (1 << dy)) === 0) continue;
        const y = band * 6 + dy;
        if (x < width && y < height) pixels[y * width + x] = color;
      }
  }
  return { width, height, pixels, palette };
}

describe("sixel", () => {
  test("a four-colour image round-trips through a sixel reader", () => {
    // 8×8, four flat quadrants: within a 256-colour palette this must come
    // back exactly, so any error is the encoder's, not the quantiser's.
    const w = 8;
    const h = 8;
    const want: number[][] = [];
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const rgb =
          x < 4
            ? y < 4
              ? [255, 0, 0]
              : [0, 0, 255]
            : y < 4
              ? [0, 255, 0]
              : [255, 255, 255];
        want.push(rgb);
        const i = (y * w + x) * 4;
        rgba[i] = rgb[0]!;
        rgba[i + 1] = rgb[1]!;
        rgba[i + 2] = rgb[2]!;
        rgba[i + 3] = 255;
      }

    const read = readSixel(sixelImage(rgba, w, h));
    expect([read.width, read.height]).toEqual([w, h]);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const index = read.pixels[y * w + x]!;
        expect(index).toBeGreaterThanOrEqual(0);
        // Palette entries are 0–100 percent; scale back to 0–255.
        const got = read.palette[index]!.map((v) =>
          Math.round((v * 255) / 100),
        );
        const expected = want[y * w + x]!;
        for (let c = 0; c < 3; c++)
          expect(Math.abs(got[c]! - expected[c]!)).toBeLessThanOrEqual(3);
      }
  });

  test("every pixel is painted, including a height that is not a multiple of six", () => {
    // Sixel works in bands of six rows; 10 rows means one full band and a
    // partial one, which is where an off-by-one leaves the last rows blank.
    const w = 5;
    const h = 10;
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = (i * 7) & 0xff;
      rgba[i * 4 + 1] = 40;
      rgba[i * 4 + 2] = 200;
      rgba[i * 4 + 3] = 255;
    }
    const read = readSixel(sixelImage(rgba, w, h));
    expect([read.width, read.height]).toEqual([w, h]);
    for (let i = 0; i < w * h; i++)
      expect(read.pixels[i]).toBeGreaterThanOrEqual(0);
  });

  test("the palette is capped and the picture still resembles itself", () => {
    // A 32-step gradient forced into 8 colours: the quantiser must produce at
    // most 8 entries and keep the ordering, not collapse to one grey.
    const w = 32;
    const h = 6;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        rgba[i] = x * 8;
        rgba[i + 3] = 255;
      }
    const read = readSixel(sixelImage(rgba, w, h, { maxColors: 8 }));
    expect(
      read.palette.filter((p) => p !== undefined).length,
    ).toBeLessThanOrEqual(8);
    const left = read.palette[read.pixels[0]!]![0]!;
    const right = read.palette[read.pixels[w - 1]!]![0]!;
    expect(right).toBeGreaterThan(left);
  });

  test("median cut splits the widest channel first", () => {
    // Two tight clusters far apart in red: two colours must separate them.
    const rgba = new Uint8Array(4 * 4);
    rgba.set([10, 0, 0, 255, 12, 0, 0, 255, 240, 0, 0, 255, 244, 0, 0, 255]);
    const { palette, indices } = quantize(rgba, 4, 1, 2);
    expect(palette.length).toBe(6);
    expect(indices[0]).toBe(indices[1]!);
    expect(indices[2]).toBe(indices[3]!);
    expect(indices[0]).not.toBe(indices[2]!);
  });
});

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

describe("placement arithmetic", () => {
  const cell = { width: 10, height: 20, measured: false };
  const box = { x: 0, y: 0, w: 80, h: 24 };

  test("a picture at its natural size uses the cells it needs", () => {
    // 400×400 pixels in 10×20 cells is 40 columns and 20 rows: a square image
    // is half as many rows as columns, which is the whole point.
    expect(placementSize(400, 400, box, cell)).toEqual({ cols: 40, rows: 20 });
  });

  test("aspect ratio survives being shrunk to fit", () => {
    const wide = placementSize(2000, 1000, box, cell);
    // 200×50 cells natural, capped by 80 columns → scale 0.4 → 80×20.
    expect(wide).toEqual({ cols: 80, rows: 20 });
    const tall = placementSize(400, 2000, box, cell);
    // 40×100 natural, capped by 24 rows → scale 0.24 → 9×24.
    expect(tall).toEqual({ cols: 9, rows: 24 });
    // Both stay inside the box.
    for (const s of [wide, tall]) {
      expect(s.cols).toBeLessThanOrEqual(box.w);
      expect(s.rows).toBeLessThanOrEqual(box.h);
    }
  });

  test("a small picture is never blown up", () => {
    expect(placementSize(20, 20, box, cell)).toEqual({ cols: 2, rows: 1 });
  });

  test("a measured cell changes the answer", () => {
    const measured = { width: 8, height: 16, measured: true };
    // 50×25 cells natural, capped by 24 rows → scale 0.96 → 48×24.
    expect(placementSize(400, 400, box, measured)).toEqual({
      cols: 48,
      rows: 24,
    });
  });

  test("degenerate inputs produce no placement rather than a negative one", () => {
    expect(placementSize(0, 10, box, cell)).toEqual({ cols: 0, rows: 0 });
    expect(placementSize(10, 10, { x: 0, y: 0, w: 0, h: 0 }, cell)).toEqual({
      cols: 0,
      rows: 0,
    });
  });
});

describe("drawImage", () => {
  const area = { x: 2, y: 1, w: 40, h: 16 };

  test("kitty: cells are reserved and the bytes come back to write", async () => {
    const caps = capabilitiesFor({ term: "xterm-kitty" });
    const bytes = await fixture("quads.png");
    const image = prepareImage(bytes, 5, caps);
    expect(image.format).toBe("png");
    expect([image.width, image.height]).toEqual([64, 48]);
    // A PNG going to kitty is never decoded: the terminal does that.
    expect(image.rgba).toBeUndefined();

    const s = new Screen(80, 24);
    const placed = drawImage(s, area, C, image, caps);
    expect(placed).toBeDefined();
    if (!placed) return;
    expect(placed.mode).toBe("kitty");
    expect(placed.id).toBe(5);
    // 64×48 pixels in 10×20 cells is 6×2, centred in the 40×16 box.
    expect([placed.rect.w, placed.rect.h]).toEqual([6, 2]);
    expect(placed.rect.x).toBe(area.x + ((area.w - 6) >> 1));

    // The reserved cells carry the theme background and nothing else, so the
    // diff renderer has no reason to paint over the picture.
    for (let y = placed.rect.y; y < placed.rect.y + placed.rect.h; y++)
      for (let x = placed.rect.x; x < placed.rect.x + placed.rect.w; x++) {
        expect(s.textAt(x, y)).toBe(" ");
        expect(s.styleAt(x, y).bg).toBe(C.bg);
      }

    // The first thing written is a cursor move to the picture's corner.
    expect(decoder.decode(placed.bytes[0]!)).toBe(
      `\x1b[${placed.rect.y + 1};${placed.rect.x + 1}H`,
    );
    const parts = parseApc(placed.bytes.slice(1));
    expect(parts[0]!.control.get("f")).toBe("100");
    expect(parts[0]!.control.get("c")).toBe("6");
    expect(parts[0]!.control.get("r")).toBe("2");
  });

  test("sixel: the picture is decoded and re-encoded at the placed size", async () => {
    const caps = capabilitiesFor({ term: "foot" });
    const image = prepareImage(await fixture("quads.png"), 1, caps);
    // Sixel cannot scale, so the pixels must exist in this process.
    expect(image.rgba).toBeDefined();
    const s = new Screen(80, 24);
    const placed = drawImage(s, area, C, image, caps);
    expect(placed?.mode).toBe("sixel");
    if (!placed) return;
    const read = readSixel(placed.bytes[1]!);
    // Downscaled to fit the placed cell rectangle, never larger.
    expect(read.width).toBeLessThanOrEqual(placed.rect.w * caps.cell.width);
    expect(read.height).toBeLessThanOrEqual(placed.rect.h * caps.cell.height);
    expect(read.width).toBeGreaterThan(0);
  });

  test("no graphics: a placeholder card, and no bytes to write", async () => {
    const caps = capabilitiesFor({ term: "xterm-256color" });
    const image = prepareImage(await fixture("quads.png"), 1, caps);
    const s = new Screen(80, 24);
    expect(drawImage(s, area, C, image, caps)).toBeUndefined();
    const text = s.toText();
    expect(text).toContain("PNG · 64×48");
    expect(text).toContain("Ghostty");
    // The card wraps rather than truncating: the sentence that says what to
    // do must survive whatever width the pane happens to have.
    expect(
      placeholderLines(image, caps, 200)
        .map((l) => l.text)
        .join(" "),
    ).toContain("Image previews need Ghostty, kitty or WezTerm.");
  });

  test("a user who turned previews off is told that, not sold a terminal", async () => {
    const caps = capabilitiesFor({ term: "xterm-kitty", graphics: "none" });
    const image = prepareImage(await fixture("quads.png"), 1, caps);
    const s = new Screen(80, 24);
    drawImage(s, area, C, image, caps);
    expect(
      placeholderLines(image, caps, 200)
        .map((l) => l.text)
        .join(" "),
    ).toContain("Image previews are off — turn them on in settings.");
  });

  test("an undecodable format says what it is and where to open it", async () => {
    const caps = capabilitiesFor({ term: "xterm-kitty" });
    const webp = new Uint8Array(64);
    webp.set([...new TextEncoder().encode("RIFF")], 0);
    webp.set([...new TextEncoder().encode("WEBP")], 8);
    expect(sniff(webp)).toBe("webp");
    const image = prepareImage(webp, 1, caps);
    expect(image.error).toBe("unsupported");
    const s = new Screen(80, 24);
    expect(drawImage(s, area, C, image, caps)).toBeUndefined();
    expect(s.toText()).toContain("WEBP");
    expect(
      placeholderLines(image, caps, 200)
        .map((l) => l.text)
        .join(" "),
    ).toContain("WebP previews aren't decoded here yet — open it on the origin.");
  });

  test("a rect too small for a card draws nothing rather than half of one", async () => {
    const caps = capabilitiesFor({ term: "xterm-kitty" });
    const image = prepareImage(await fixture("quads.png"), 1, caps);
    const s = new Screen(80, 24);
    expect(
      drawImage(s, { x: 0, y: 0, w: 1, h: 1 }, C, image, caps),
    ).toBeUndefined();
    expect(s.toText().trim()).toBe("");
  });

  test("clearing is a delete for kitty and nothing for the rest", () => {
    expect(clearImages(capabilitiesFor({ term: "xterm-kitty" })).length).toBe(
      1,
    );
    expect(clearImages(capabilitiesFor({ term: "foot" }))).toEqual([]);
    expect(clearImages(capabilitiesFor({ term: "xterm" }))).toEqual([]);
  });

  test("sizes read the way a file listing writes them", () => {
    expect(humanBytes(0)).toBe("0 B");
    expect(humanBytes(999)).toBe("999 B");
    expect(humanBytes(2048)).toBe("2.0 kB");
    expect(humanBytes(219_136)).toBe("214 kB");
    expect(humanBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

// ---------------------------------------------------------------------------
// The format facade
// ---------------------------------------------------------------------------

describe("sniffing", () => {
  const encoder = new TextEncoder();
  const magic = (...parts: (string | number[])[]): Uint8Array => {
    const bytes: number[] = [];
    for (const p of parts)
      if (typeof p === "string") bytes.push(...encoder.encode(p));
      else bytes.push(...p);
    while (bytes.length < 32) bytes.push(0);
    return new Uint8Array(bytes);
  };

  test("format comes from the bytes, never from the name", () => {
    expect(sniff(magic([0x89], "PNG\r\n", [0x1a, 0x0a]))).toBe("png");
    expect(sniff(magic([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniff(magic("GIF89a"))).toBe("gif");
    expect(sniff(magic("GIF87a"))).toBe("gif");
    expect(sniff(magic("RIFF", [0, 0, 0, 0], "WEBP"))).toBe("webp");
    expect(sniff(magic("BM"))).toBe("bmp");
    expect(sniff(magic("<svg viewBox='0 0 1 1'></svg>"))).toBe("svg");
    expect(sniff(magic("  \n<svg />"))).toBe("svg");
    expect(sniff(magic('<?xml version="1.0"?><svg></svg>'))).toBe("svg");
    expect(sniff(magic("not an image at all"))).toBeUndefined();
    expect(sniff(new Uint8Array(0))).toBeUndefined();
    // RIFF that is not WEBP (a WAV) must not be claimed.
    expect(sniff(magic("RIFF", [0, 0, 0, 0], "WAVE"))).toBeUndefined();
    // XML that is not SVG.
    expect(sniff(magic('<?xml version="1.0"?><rss></rss>'))).toBeUndefined();
  });

  test("a real fixture is what it claims", async () => {
    expect(sniff(await fixture("quads.png"))).toBe("png");
    expect(sniff(await fixture("quads-baseline.jpg"))).toBe("jpeg");
    expect(sniff(await fixture("quads.gif"))).toBe("gif");
  });
});

describe("decode limits", () => {
  test("formats we cannot decode are unsupported, not corrupt", () => {
    const bmp = new Uint8Array(64);
    bmp[0] = 0x42;
    bmp[1] = 0x4d;
    expect(decode(bmp)).toEqual({ ok: false, error: "unsupported" });
    expect(decode(new TextEncoder().encode("<svg></svg>"))).toEqual({
      ok: false,
      error: "unsupported",
    });
    expect(decode(new Uint8Array([1, 2, 3]))).toEqual({
      ok: false,
      error: "unsupported",
    });
  });

  test("an enormous picture is refused from its header, not decoded", () => {
    // A 30000×30000 PNG is 33 bytes of header and 3.6 GB of RGBA. The refusal
    // has to happen before any allocation, which is why the header parse is
    // separate from the decode.
    const ihdr = new Uint8Array(33);
    ihdr.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(ihdr.buffer);
    view.setUint32(8, 13);
    ihdr.set([...new TextEncoder().encode("IHDR")], 12);
    view.setUint32(16, 30000);
    view.setUint32(20, 30000);
    ihdr[24] = 8; // depth
    ihdr[25] = 6; // RGBA
    expect(30000 * 30000).toBeGreaterThan(MAX_PIXELS);
    expect(decode(ihdr)).toEqual({ ok: false, error: "too_large" });
  });
});

describe("thumbnail", () => {
  test("box filtering averages, it does not sample", () => {
    // A 2×2 checker of black and white must average to mid grey, not pick a
    // corner — nearest-neighbour would give 0 or 255.
    const rgba = new Uint8Array([
      255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255,
    ]);
    const out = thumbnail(rgba, 2, 2, 1, 1);
    expect([out.width, out.height]).toEqual([1, 1]);
    expect(out.rgba[0]).toBeGreaterThan(120);
    expect(out.rgba[0]).toBeLessThan(136);
  });

  test("aspect ratio is preserved and upscaling is refused", () => {
    const rgba = new Uint8Array(40 * 20 * 4).fill(255);
    const half = thumbnail(rgba, 40, 20, 20, 20);
    expect([half.width, half.height]).toEqual([20, 10]);
    // Asked for more than it has, it hands back the original untouched.
    const same = thumbnail(rgba, 40, 20, 400, 200);
    expect([same.width, same.height]).toEqual([40, 20]);
    expect(same.rgba).toBe(rgba);
  });

  test("a real photograph shrinks without losing its colours", async () => {
    const out = decode(await fixture("quads.png"));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const small = thumbnail(out.value.rgba, 64, 48, 16, 16);
    expect([small.width, small.height]).toEqual([16, 12]);
    const at = (x: number, y: number): number[] => {
      const i = (y * small.width + x) * 4;
      return [small.rgba[i]!, small.rgba[i + 1]!, small.rgba[i + 2]!];
    };
    // The quadrants survive the reduction; only the diagonal is blurred away.
    expect(at(2, 5)[0]).toBeGreaterThan(200);
    expect(at(12, 1)[1]).toBeGreaterThan(200);
    expect(at(2, 10)[2]).toBeGreaterThan(200);
  });
});
