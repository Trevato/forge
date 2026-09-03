/**
 * Pictures in a terminal: what this session can show, and the bytes that show
 * it. Nothing above `term/` writes an escape sequence by hand.
 *
 * ## The two protocols, as bytes
 *
 * **kitty graphics protocol** (the spec:
 * <https://sw.kovidgoyal.net/kitty/graphics-protocol/>). One APC sequence per
 * chunk:
 *
 *     ESC _ G <key>=<value>,<key>=<value>,… ; <base64 payload> ESC \
 *
 * The keys we use, and why:
 *   - `a=T`   transmit **and** display in one sequence. `a=d` deletes.
 *   - `f=100` the payload is a PNG file — the terminal decodes it, which is
 *             both faster and better than anything we could hand it.
 *             `f=24`/`f=32` are raw RGB/RGBA, and *require* `s`/`v`.
 *   - `i`     image id, so we can delete exactly this image later.
 *   - `s`,`v` source pixel width/height (raw formats only).
 *   - `c`,`r` display size in **cells**. Handing the terminal a cell
 *             rectangle and letting it scale is the whole trick: it knows its
 *             own cell geometry and we are guessing at ours.
 *   - `q=2`   suppress both OK and error replies. A reply would arrive on the
 *             input stream and be parsed as keystrokes — over SSH there is no
 *             other stream for it to arrive on.
 *   - `C=1`   do not move the cursor. The diff renderer owns the cursor and
 *             would be desynchronised by a protocol that moved it.
 *   - `m=1/0` more-chunks-follow / last chunk. The payload is split at 4096
 *             base64 bytes, and every chunk after the first carries **only**
 *             `m` (and `q`) — repeating `f`, `s` or `i` on a continuation is
 *             a protocol error.
 *
 * **Sixel** (DEC VT330/VT340 programmer reference, ch. 14:
 * <https://vt100.net/docs/vt3xx-gp/chapter14.html>), for terminals that speak
 * only that:
 *
 *     ESC P <P1>;<P2>;<P3> q  "<Pan>;<Pad>;<Ph>;<Pv>  <colours><data>  ESC \
 *
 * with `P2=1` meaning "leave zero pixels alone" (transparent), colours
 * introduced as `#<reg>;2;<r>;<g>;<b>` on a **0–100** scale, not 0–255, and
 * pixel data in bands of six rows where each character `0x3F..0x7E` carries
 * six vertical pixels as bits 0..5. `!<n>` repeats, `$` returns to the start
 * of the band for another colour pass, `-` starts the next band.
 */

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** What this session can actually do with an image. */
export type GraphicsMode = "kitty" | "sixel" | "iterm" | "none";

/** The per-user setting. `auto` means "work it out from TERM". */
export type GraphicsSetting = "auto" | "kitty" | "sixel" | "iterm" | "none";

export type IconSet = "plain" | "nerd";
export type IconSetting = "auto" | "nerd" | "plain";

/** `user_setting` keys. Read by the TUI, written by the settings screen. */
export const GRAPHICS_KEY = "graphics";
export const ICONS_KEY = "icons";

/** Every value each setting takes, in the order a picker cycles them. */
export const GRAPHICS_SETTINGS: readonly GraphicsSetting[] = [
  "auto",
  "kitty",
  "sixel",
  "iterm",
  "none",
];
export const ICON_SETTINGS: readonly IconSetting[] = ["auto", "nerd", "plain"];

export interface CellSize {
  readonly width: number;
  readonly height: number;
  /** False when this is the 1:2 guess rather than a size the client reported. */
  readonly measured: boolean;
}

export interface TermCapabilities {
  /** The `TERM` the client announced — over SSH, the only env var we get. */
  readonly term: string | undefined;
  readonly graphics: GraphicsMode;
  readonly icons: IconSet;
  readonly cell: CellSize;
  /** Whether each answer came from the user's setting or from a guess. */
  readonly graphicsFrom: "setting" | "term";
  readonly iconsFrom: "setting" | "term";
}

export interface CapabilityInput {
  readonly term?: string | undefined;
  readonly graphics?: GraphicsSetting | undefined;
  readonly icons?: IconSetting | undefined;
  /** Terminal size, and the pixel size of the window if the client sent one. */
  readonly cols?: number | undefined;
  readonly rows?: number | undefined;
  readonly pixelWidth?: number | undefined;
  readonly pixelHeight?: number | undefined;
}

/**
 * The `TERM` table. It is short on purpose: `TERM` is the *only* thing SSH
 * forwards (`pty-req` carries it; `TERM_PROGRAM`, `COLORTERM` and the rest
 * never arrive), so every entry here has to be a name a terminal actually
 * sets for itself, and everything else is `none` plus a setting the user can
 * flip. Guessing wrong in the "yes" direction paints escape-sequence soup
 * across someone's screen, which is much worse than a placeholder card.
 *
 *   xterm-kitty      kitty      the protocol's origin
 *   xterm-ghostty    kitty      Ghostty implements it in full; it has no sixel
 *   wezterm          kitty      WezTerm speaks kitty, sixel and iTerm2; kitty
 *                               is the one with cell-accurate placement
 *   foot, foot-*     sixel      sixel only
 *   mlterm           sixel      sixel only
 *   yaft*            sixel      sixel only
 *
 * Notably absent: `xterm` (sixel is a compile- and `decTerminalID`-gated
 * option, so the name proves nothing) and iTerm2 (it reports
 * `xterm-256color`, which is indistinguishable from half the world — its
 * users set `graphics: iterm` by hand).
 */
export function graphicsFromTerm(term: string | undefined): GraphicsMode {
  if (term === undefined || term === "") return "none";
  const t = term.toLowerCase();
  if (t.includes("kitty") || t.includes("ghostty") || t.includes("wezterm"))
    return "kitty";
  if (t === "foot" || t.startsWith("foot-")) return "sixel";
  if (t.includes("mlterm") || t.startsWith("yaft")) return "sixel";
  return "none";
}

/**
 * Nerd Font glyphs, guessed from `TERM`.
 *
 * This is a guess about a *font*, from a variable that says nothing about
 * fonts — it is only defensible because the three terminals below are ones
 * people install deliberately, and installing a Nerd Font is the next thing
 * those people do. It is documented as a guess in the settings screen and
 * `icons: plain` turns it off in one keypress, which is the honest contract:
 * a missing glyph shows as a tofu box, not as a broken layout, because every
 * icon here is exactly one cell wide either way.
 */
export function iconsFromTerm(term: string | undefined): IconSet {
  const t = (term ?? "").toLowerCase();
  return t.includes("kitty") || t.includes("ghostty") || t.includes("wezterm")
    ? "nerd"
    : "plain";
}

/** A cell is about twice as tall as it is wide in every font anyone uses. */
const GUESSED_CELL: CellSize = { width: 10, height: 20, measured: false };

export function capabilitiesFor(input: CapabilityInput): TermCapabilities {
  const setting = input.graphics ?? "auto";
  const graphics =
    setting === "auto"
      ? graphicsFromTerm(input.term)
      : (setting as GraphicsMode);
  const iconSetting = input.icons ?? "auto";
  const icons =
    iconSetting === "auto"
      ? iconsFromTerm(input.term)
      : (iconSetting as IconSet);
  return {
    term: input.term,
    graphics,
    icons,
    cell: cellSize(input),
    graphicsFrom: setting === "auto" ? "term" : "setting",
    iconsFrom: iconSetting === "auto" ? "term" : "setting",
  };
}

/**
 * Cell geometry from the window's pixel size, when the client sent one.
 *
 * `pty-req` and `window-change` both carry pixel dimensions alongside the
 * character ones, and most clients send zeros — so a measured cell is a
 * bonus, never a requirement, and the guess has to be good enough to ship on
 * its own. Absurd results (a 3-pixel cell, a 200-pixel one) are discarded
 * rather than trusted: they mean the client is reporting something other than
 * what we assume.
 */
export function cellSize(input: CapabilityInput): CellSize {
  const { cols, rows, pixelWidth, pixelHeight } = input;
  if (!cols || !rows || !pixelWidth || !pixelHeight) return GUESSED_CELL;
  const width = Math.floor(pixelWidth / cols);
  const height = Math.floor(pixelHeight / rows);
  if (width < 4 || width > 64 || height < 6 || height > 128)
    return GUESSED_CELL;
  return { width, height, measured: true };
}

export function parseGraphicsSetting(
  value: string | undefined,
): GraphicsSetting | undefined {
  return value === "auto" ||
    value === "kitty" ||
    value === "sixel" ||
    value === "iterm" ||
    value === "none"
    ? value
    : undefined;
}

export function parseIconSetting(
  value: string | undefined,
): IconSetting | undefined {
  return value === "auto" || value === "nerd" || value === "plain"
    ? value
    : undefined;
}

/**
 * Whether a mode takes a PNG file verbatim. When it does, the decoder never
 * has to run: a 4 MB screenshot stays 4 MB instead of becoming 60 MB of RGBA
 * in this process, and the terminal's own decoder is better than ours.
 */
export function passesThroughPng(mode: GraphicsMode): boolean {
  return mode === "kitty" || mode === "iterm";
}

// ---------------------------------------------------------------------------
// kitty graphics protocol
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** The kitty spec's cap: 4096 bytes of base64 per escape sequence. */
export const KITTY_CHUNK = 4096;

export interface KittyImage {
  /** Image id, 1..4294967295. Ours are small and assigned per placement. */
  readonly id: number;
  readonly format: "png" | "rgb" | "rgba";
  /** Source pixel size. Required by the protocol for `rgb`/`rgba`. */
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  /** Placement size in cells. Omitted, the terminal uses the natural size. */
  readonly cols?: number;
  readonly rows?: number;
}

/**
 * One image as a list of escape sequences, to be written in order.
 *
 * A list rather than one buffer because that is the unit the transport should
 * see: an SSH channel with a small window can flush between chunks, and a
 * test can assert the chunking without re-splitting a blob.
 */
export function kittyImage(image: KittyImage): Uint8Array[] {
  const payload = base64(image.data);
  const control: string[] = [
    "a=T",
    `f=${image.format === "png" ? 100 : image.format === "rgb" ? 24 : 32}`,
    `i=${image.id}`,
    "q=2",
    // The renderer positions the cursor itself; a protocol that moved it
    // would put the next frame's first cell in the wrong place.
    "C=1",
  ];
  // s/v are for raw pixels only — a PNG carries its own dimensions, and the
  // spec does not want them repeated.
  if (image.format !== "png")
    control.push(`s=${image.width}`, `v=${image.height}`);
  if (image.cols !== undefined && image.rows !== undefined)
    control.push(`c=${image.cols}`, `r=${image.rows}`);

  const out: Uint8Array[] = [];
  const chunks = Math.max(1, Math.ceil(payload.length / KITTY_CHUNK));
  for (let i = 0; i < chunks; i++) {
    const slice = payload.slice(i * KITTY_CHUNK, (i + 1) * KITTY_CHUNK);
    const more = i < chunks - 1 ? 1 : 0;
    const keys =
      i === 0
        ? [...control, `m=${more}`].join(",")
        : // Continuation chunks carry only `m` (plus the quiet level, which
          // kitty accepts and which keeps a mid-stream error silent).
          `m=${more},q=2`;
    out.push(encoder.encode(`\x1b_G${keys};${slice}\x1b\\`));
  }
  return out;
}

/**
 * Delete an image and free its data (`d=I`), or every image on the screen
 * (`d=A`). The uppercase forms are the ones that release memory — the
 * lowercase twins drop the placement and keep the pixels, which for a session
 * that browses a repository of screenshots is an unbounded leak in the
 * terminal, not in us.
 */
export function kittyDelete(id?: number): Uint8Array {
  return encoder.encode(
    id === undefined
      ? "\x1b_Ga=d,d=A,q=2\x1b\\"
      : `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`,
  );
}

// ---------------------------------------------------------------------------
// iTerm2 inline images
// ---------------------------------------------------------------------------

/**
 * iTerm2's OSC 1337 form, offered because iTerm2 is common and cannot be
 * detected (see the table above) — a user who sets `graphics: iterm` gets it.
 * The whole file goes in one sequence; there is no chunking in this protocol.
 *
 * <https://iterm2.com/documentation-images.html>
 */
export function itermImage(
  data: Uint8Array,
  o: { cols: number; rows: number; name?: string },
): Uint8Array {
  const name = base64(encoder.encode(o.name ?? "image"));
  const args = `name=${name};size=${data.length};width=${o.cols};height=${o.rows};preserveAspectRatio=1;inline=1`;
  return encoder.encode(`\x1b]1337;File=${args}:${base64(data)}\x07`);
}

// ---------------------------------------------------------------------------
// Sixel
// ---------------------------------------------------------------------------

export interface SixelOpts {
  /** Palette ceiling. 256 is the DEC maximum every terminal implements. */
  readonly maxColors?: number;
}

/**
 * RGBA → one sixel sequence.
 *
 * Sixel has no scaling and no truecolor: the caller must hand over pixels at
 * the size they should appear, and we must fit the picture into at most 256
 * colour registers. That quantisation is a median cut — repeatedly split the
 * colour box with the widest channel at its median, then average each box —
 * which is 40 lines, deterministic, and visibly better than a fixed 6×6×6
 * cube on the photographs and screenshots people actually commit.
 */
export function sixelImage(
  rgba: Uint8Array,
  width: number,
  height: number,
  o: SixelOpts = {},
): Uint8Array {
  const maxColors = Math.max(2, Math.min(256, o.maxColors ?? 256));
  const { palette, indices } = quantize(rgba, width, height, maxColors);

  const parts: string[] = [];
  // P1=0 (aspect from the raster attributes), P2=1 (zero pixels transparent),
  // P3=0. Then the raster attributes, which tell the terminal how much space
  // to reserve before it has parsed the data.
  parts.push(`\x1bP0;1;0q"1;1;${width};${height}`);
  for (let i = 0; i < palette.length; i += 3) {
    // 0–100 percent per channel, not 0–255. Rounding rather than truncating
    // keeps pure white at 100 instead of 99.
    const r = Math.round((palette[i]! * 100) / 255);
    const g = Math.round((palette[i + 1]! * 100) / 255);
    const b = Math.round((palette[i + 2]! * 100) / 255);
    parts.push(`#${i / 3};2;${r};${g};${b}`);
  }

  const bands = Math.ceil(height / 6);
  const rows = new Map<number, Uint8Array>();
  for (let band = 0; band < bands; band++) {
    rows.clear();
    const top = band * 6;
    const depth = Math.min(6, height - top);
    for (let dy = 0; dy < depth; dy++) {
      const line = (top + dy) * width;
      for (let x = 0; x < width; x++) {
        const color = indices[line + x]!;
        let bits = rows.get(color);
        if (bits === undefined) {
          bits = new Uint8Array(width);
          rows.set(color, bits);
        }
        bits[x] = bits[x]! | (1 << dy);
      }
    }
    let first = true;
    for (const [color, bits] of rows) {
      // `$` returns to the left edge for the next colour's pass over the same
      // band; the first pass needs no return.
      parts.push(first ? `#${color}` : `$#${color}`);
      first = false;
      parts.push(runLengths(bits, width));
    }
    if (band < bands - 1) parts.push("-");
  }
  parts.push("\x1b\\");
  return encoder.encode(parts.join(""));
}

/** Sixel data for one colour in one band, run-length encoded. */
function runLengths(bits: Uint8Array, width: number): string {
  // Trailing empties need not be emitted at all: the band is already blank.
  let end = width;
  while (end > 0 && bits[end - 1] === 0) end--;
  let out = "";
  let x = 0;
  while (x < end) {
    const value = bits[x]!;
    let run = 1;
    while (x + run < end && bits[x + run] === value) run++;
    const ch = String.fromCharCode(0x3f + value);
    // `!n` costs three characters plus the digits, so it only pays from four.
    if (run >= 4) out += `!${run}${ch}`;
    else out += ch.repeat(run);
    x += run;
  }
  return out;
}

interface Quantized {
  /** Flat RGB triples, `colors * 3` long. */
  readonly palette: Uint8Array;
  /** One palette index per pixel. */
  readonly indices: Uint8Array;
}

interface Box {
  /** Indexes into the sample list this box owns. */
  from: number;
  to: number;
  channel: number;
  spread: number;
}

/** Median-cut quantisation to at most `maxColors` colours. */
export function quantize(
  rgba: Uint8Array,
  width: number,
  height: number,
  maxColors: number,
): Quantized {
  const count = width * height;
  // Work on a copy of the RGB triples so the boxes can be sorted in place.
  const samples = new Uint8Array(count * 3);
  for (let i = 0, o = 0; i < count; i++, o += 3) {
    samples[o] = rgba[i * 4]!;
    samples[o + 1] = rgba[i * 4 + 1]!;
    samples[o + 2] = rgba[i * 4 + 2]!;
  }
  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;

  const boxes: Box[] = [measureBox(samples, order, 0, count)];
  while (boxes.length < maxColors) {
    // Split the box with the widest channel: the split that removes the most
    // error per colour spent.
    let best = -1;
    for (let i = 0; i < boxes.length; i++)
      if (
        boxes[i]!.spread > 0 &&
        boxes[i]!.to - boxes[i]!.from > 1 &&
        (best === -1 || boxes[i]!.spread > boxes[best]!.spread)
      )
        best = i;
    if (best === -1) break;
    const box = boxes[best]!;
    sortRange(samples, order, box.from, box.to, box.channel);
    const mid = (box.from + box.to) >> 1;
    boxes[best] = measureBox(samples, order, box.from, mid);
    boxes.push(measureBox(samples, order, mid, box.to));
  }

  const palette = new Uint8Array(boxes.length * 3);
  for (const [i, box] of boxes.entries()) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let k = box.from; k < box.to; k++) {
      const s = order[k]! * 3;
      r += samples[s]!;
      g += samples[s + 1]!;
      b += samples[s + 2]!;
    }
    const n = Math.max(1, box.to - box.from);
    palette[i * 3] = Math.round(r / n);
    palette[i * 3 + 1] = Math.round(g / n);
    palette[i * 3 + 2] = Math.round(b / n);
  }

  // Nearest-palette lookup, memoised on the top 5 bits per channel. Without
  // the cache this is width·height·colours compares; with it, it is at most
  // 32768 of them however big the picture is.
  const cache = new Int16Array(32768).fill(-1);
  const indices = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const r = rgba[i * 4]!;
    const g = rgba[i * 4 + 1]!;
    const b = rgba[i * 4 + 2]!;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let hit = cache[key]!;
    if (hit < 0) {
      hit = nearest(palette, r, g, b);
      cache[key] = hit;
    }
    indices[i] = hit;
  }
  return { palette, indices };
}

function nearest(palette: Uint8Array, r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i += 3) {
    const dr = palette[i]! - r;
    const dg = palette[i + 1]! - g;
    const db = palette[i + 2]! - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i / 3;
    }
  }
  return best;
}

function measureBox(
  samples: Uint8Array,
  order: Int32Array,
  from: number,
  to: number,
): Box {
  const lo = [255, 255, 255];
  const hi = [0, 0, 0];
  for (let k = from; k < to; k++) {
    const s = order[k]! * 3;
    for (let c = 0; c < 3; c++) {
      const v = samples[s + c]!;
      if (v < lo[c]!) lo[c] = v;
      if (v > hi[c]!) hi[c] = v;
    }
  }
  let channel = 0;
  let spread = 0;
  for (let c = 0; c < 3; c++) {
    const width = hi[c]! - lo[c]!;
    if (width > spread) {
      spread = width;
      channel = c;
    }
  }
  return { from, to, channel, spread };
}

function sortRange(
  samples: Uint8Array,
  order: Int32Array,
  from: number,
  to: number,
  channel: number,
): void {
  const slice = Array.from(order.subarray(from, to));
  slice.sort((a, b) => samples[a * 3 + channel]! - samples[b * 3 + channel]!);
  order.set(slice, from);
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "base64",
  );
}
