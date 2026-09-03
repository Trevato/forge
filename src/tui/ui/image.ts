/**
 * An image inside a `Rect`.
 *
 * Images do not live in the cell grid, which is the whole design problem: the
 * diff renderer owns cells and knows nothing about pixels, so `drawImage`
 * does two things that must both happen and must happen in this order.
 *
 *   1. **Reserve the cells.** The area is filled with the theme background,
 *      so from the renderer's point of view it is an unchanging block. After
 *      the first frame it emits nothing there, and the picture underneath is
 *      left alone.
 *   2. **Return the bytes.** They are written *after* the frame, raw, through
 *      the `Terminal` — never through the `Screen`. A `Placement` is that
 *      hand-off, and it is deliberately a value the caller must do something
 *      with rather than a side effect.
 *
 * The caller owes two things back: write the placement after each frame in
 * which the renderer repainted (a resize, a theme change, anything that calls
 * `invalidate()`), and write `clearImages` when leaving the screen. Nothing
 * here can know when either happens.
 *
 * When the terminal cannot show a picture at all, `drawImage` draws a
 * placeholder card and returns `undefined` — a small honest statement of what
 * the file is and what would be needed to see it, which is far better than a
 * blank space or a wall of escape sequences.
 */

import type { Database } from "bun:sqlite";
import { getUserSetting } from "../../core/settings.ts";
import {
  decode,
  measure,
  sniff,
  thumbnail,
  toRgb,
  flatten,
  unsupportedReason,
  type DecodeError,
  type ImageFormat,
} from "../../design/image/image.ts";
import { cup } from "../term/ansi.ts";
import {
  GRAPHICS_KEY,
  ICONS_KEY,
  itermImage,
  kittyDelete,
  kittyImage,
  parseGraphicsSetting,
  parseIconSetting,
  passesThroughPng,
  sixelImage,
  type CellSize,
  type GraphicsSetting,
  type IconSetting,
  type TermCapabilities,
} from "../term/graphics.ts";
import { box, type Rect, type Screen } from "../term/screen.ts";
import { style } from "../term/style.ts";
import { truncate, wrap } from "../term/width.ts";
import type { Tokens } from "./theme.ts";

const encoder = new TextEncoder();

/** One image, ready to place: what it is, and (when we could) its pixels. */
export interface TerminalImage {
  /** Placement id. Stable per file per screen so a redraw replaces, not stacks. */
  readonly id: number;
  readonly format: ImageFormat | undefined;
  /** Displayed geometry — after EXIF rotation, so it is what the user sees. */
  readonly width: number;
  readonly height: number;
  /** Size of the file on disk, for the caption. */
  readonly byteLength: number;
  /** The original bytes, kept because kitty and iTerm2 take a PNG verbatim. */
  readonly bytes: Uint8Array;
  readonly rgba: Uint8Array | undefined;
  readonly error: DecodeError | undefined;
}

export interface Placement {
  readonly mode: "kitty" | "sixel" | "iterm";
  readonly id: number;
  /** The cells the picture covers — reserved in the grid, painted by pixels. */
  readonly rect: Rect;
  /** Write these to the `Terminal`, in order, after the frame. */
  readonly bytes: Uint8Array[];
}

/**
 * Read the file. Decoding is skipped for a format the terminal takes verbatim
 * *and* whose geometry we can read from the header — a 4 MB PNG shown in
 * Ghostty never needs to become 60 MB of RGBA in this process.
 */
export function prepareImage(
  bytes: Uint8Array,
  id: number,
  caps: TermCapabilities,
): TerminalImage {
  // Identity comes from the sniff — a WebP has no header reader here but is
  // still a WebP, and the card must say so.
  const format = sniff(bytes);
  const meta = measure(bytes);
  const passthrough = format === "png" && passesThroughPng(caps.graphics);
  const base = {
    id,
    format,
    byteLength: bytes.length,
    bytes,
  };
  if (meta !== undefined && (passthrough || caps.graphics === "none"))
    return {
      ...base,
      width: meta.width,
      height: meta.height,
      rgba: undefined,
      error: undefined,
    };
  const decoded = decode(bytes);
  if (!decoded.ok)
    return {
      ...base,
      width: meta?.width ?? 0,
      height: meta?.height ?? 0,
      rgba: undefined,
      error: decoded.error,
    };
  return {
    ...base,
    width: decoded.value.width,
    height: decoded.value.height,
    rgba: decoded.value.rgba,
    error: undefined,
  };
}

/**
 * How many cells a picture of this pixel size should occupy inside `r`.
 *
 * The arithmetic that matters is the cell aspect: cells are about twice as
 * tall as wide, so a square image is half as many rows as columns. Getting
 * this wrong is the classic terminal-image bug — a stretched picture that
 * looks like a rendering fault rather than a maths one. `cell` carries a
 * measured size when the client reported its window in pixels, and the 1:2
 * guess otherwise.
 */
export function placementSize(
  imageWidth: number,
  imageHeight: number,
  r: Rect,
  cell: CellSize,
): { cols: number; rows: number } {
  if (imageWidth <= 0 || imageHeight <= 0 || r.w <= 0 || r.h <= 0)
    return { cols: 0, rows: 0 };
  // Natural size in cells, then shrink to fit — never enlarge past the
  // available box, and never enlarge a small image past its natural pixels.
  const naturalCols = imageWidth / cell.width;
  const naturalRows = imageHeight / cell.height;
  const scale = Math.min(1, r.w / naturalCols, r.h / naturalRows);
  const cols = Math.max(1, Math.min(r.w, Math.floor(naturalCols * scale)));
  const rows = Math.max(1, Math.min(r.h, Math.floor(naturalRows * scale)));
  return { cols, rows };
}

/**
 * Draw `image` into `r`. Returns the placement to write after the frame, or
 * `undefined` when a placeholder card was drawn instead.
 *
 * Argument order follows the widget vocabulary — screen, rect, tokens, then
 * the widget's own arguments — so this reads like every other thing in `ui/`.
 */
export function drawImage(
  s: Screen,
  r: Rect,
  c: Tokens,
  image: TerminalImage,
  caps: TermCapabilities,
): Placement | undefined {
  if (r.w < 2 || r.h < 2) return undefined;
  if (caps.graphics === "none" || image.width === 0 || image.height === 0) {
    placeholder(s, r, c, image, caps);
    return undefined;
  }

  const size = placementSize(image.width, image.height, r, caps.cell);
  // Centre the picture in its box; the leftover cells keep the theme ground.
  const area: Rect = {
    x: r.x + ((r.w - size.cols) >> 1),
    y: r.y + ((r.h - size.rows) >> 1),
    w: size.cols,
    h: size.rows,
  };
  // The theme background, so a transparent PNG is composited onto the same
  // colour as the cells around it rather than onto the terminal's own ground.
  const ground = c.bg >= 0 ? c.bg : 0x000000;
  const bytes = encodeFor(image, area, caps, ground);
  if (bytes === undefined) {
    placeholder(s, r, c, image, caps);
    return undefined;
  }

  // Reserve: a solid block of theme background. The diff renderer sees an
  // unchanging region and stops emitting into it, which is exactly what keeps
  // the pixels underneath from being overdrawn a frame later.
  s.fill(area, " ", style(c.fg, c.bg));

  return {
    mode:
      caps.graphics === "sixel"
        ? "sixel"
        : caps.graphics === "iterm"
          ? "iterm"
          : "kitty",
    id: image.id,
    rect: area,
    // Park the cursor at the picture's top-left, then draw. Both protocols
    // place at the cursor, and the frame that follows repositions it anyway.
    bytes: [encoder.encode(cup(area.y, area.x)), ...bytes],
  };
}

function encodeFor(
  image: TerminalImage,
  area: Rect,
  caps: TermCapabilities,
  ground: number,
): Uint8Array[] | undefined {
  if (caps.graphics === "kitty") {
    if (image.format === "png")
      return kittyImage({
        id: image.id,
        format: "png",
        width: image.width,
        height: image.height,
        data: image.bytes,
        cols: area.w,
        rows: area.h,
      });
    if (image.rgba === undefined) return undefined;
    // Raw pixels rather than re-encoding a PNG: kitty takes RGB directly, and
    // an alpha channel flattened onto the theme ground is 25% of the bytes
    // for a seam nobody wants anyway.
    return kittyImage({
      id: image.id,
      format: "rgb",
      width: image.width,
      height: image.height,
      data: toRgb(flatten(image.rgba, ground)),
      cols: area.w,
      rows: area.h,
    });
  }
  if (caps.graphics === "iterm") {
    // iTerm2's protocol takes a *file*, so only a format it decodes itself
    // can go through; we do not re-encode.
    if (image.format === undefined) return undefined;
    return [itermImage(image.bytes, { cols: area.w, rows: area.h })];
  }
  if (caps.graphics === "sixel") {
    if (image.rgba === undefined) return undefined;
    // Sixel neither scales nor blends: we must hand over exactly the pixels
    // that should appear, already composited onto the ground behind them.
    const target = thumbnail(
      flatten(image.rgba, ground),
      image.width,
      image.height,
      area.w * caps.cell.width,
      area.h * caps.cell.height,
    );
    return [sixelImage(target.rgba, target.width, target.height)];
  }
  return undefined;
}

/**
 * Bytes that remove every image this session placed. Written on leaving a
 * screen and on resize — a kitty placement is anchored to a cell, so after a
 * reflow it is sitting on top of unrelated text until something clears it.
 */
export function clearImages(caps: TermCapabilities): Uint8Array[] {
  if (caps.graphics === "kitty") return [kittyDelete()];
  // Sixel and iTerm2 images are painted into the terminal's own cell grid, so
  // the next full repaint (an erase-all) removes them; there is no handle to
  // delete and nothing useful to send.
  return [];
}

/** Bytes that remove one placement by id. */
export function clearImage(id: number, caps: TermCapabilities): Uint8Array[] {
  return caps.graphics === "kitty" ? [kittyDelete(id)] : [];
}

// ---------------------------------------------------------------------------
// The placeholder
// ---------------------------------------------------------------------------

/**
 * What a terminal with no graphics gets. It names the format, the geometry
 * and the size, then says plainly what would show the picture — a user who
 * sees this should know both that nothing is broken and what to do about it.
 */
function placeholder(
  s: Screen,
  r: Rect,
  c: Tokens,
  image: TerminalImage,
  caps: TermCapabilities,
): void {
  const inner = box(s, r, {
    style: style(c.border, c.bg),
    fill: style(c.fg, c.bg),
  });
  if (inner.w <= 0 || inner.h <= 0) return;
  const lines = placeholderLines(image, caps, inner.w);
  const top = inner.y + Math.max(0, (inner.h - lines.length) >> 1);
  for (const [i, line] of lines.entries()) {
    if (top + i >= inner.y + inner.h) break;
    s.line(
      { ...inner, y: top + i, h: 1 },
      0,
      truncate(line.text, inner.w),
      style(line.dim ? c.mutedFg : c.fg, c.bg),
      "center",
    );
  }
}

export function placeholderLines(
  image: TerminalImage,
  caps: TermCapabilities,
  width: number,
): { text: string; dim: boolean }[] {
  const label = (image.format ?? "file").toUpperCase();
  const geometry =
    image.width > 0 && image.height > 0 ? `${image.width}×${image.height}` : "";
  const head = [label, geometry, humanBytes(image.byteLength)]
    .filter((p) => p !== "")
    .join(" · ");
  // The explanation wraps rather than truncating: it is the half of the card
  // that tells the user what to do, so an ellipsis eats the actionable part.
  return [
    { text: head, dim: false },
    ...wrap(explain(image, caps), Math.max(8, width)).map((text) => ({
      text,
      dim: true,
    })),
  ];
}

function explain(image: TerminalImage, caps: TermCapabilities): string {
  if (image.error === "too_large")
    return "Too large to preview here — open it on the origin.";
  if (image.error === "corrupt") return "This file isn't a readable image.";
  if (image.error === "unsupported") return unsupportedReason(image.format);
  if (caps.graphics === "none")
    return caps.graphicsFrom === "setting"
      ? "Image previews are off — turn them on in settings."
      : "Image previews need Ghostty, kitty or WezTerm.";
  return "This image can't be shown in this terminal.";
}

/** Sizes the way a file listing writes them: three significant figures, kB. */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["kB", "MB", "GB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface GraphicsPrefs {
  readonly graphics: GraphicsSetting;
  readonly icons: IconSetting;
}

/**
 * The two stored preferences, read-only. A guest has none and gets `auto`,
 * which is the same answer a signed-in user who never touched settings gets —
 * the setting exists to override a guess, not to enable the feature.
 */
export function readGraphicsPrefs(
  db: Database,
  userId: string | undefined,
): GraphicsPrefs {
  if (userId === undefined) return { graphics: "auto", icons: "auto" };
  return {
    graphics:
      parseGraphicsSetting(getUserSetting(db, userId, GRAPHICS_KEY)) ?? "auto",
    icons: parseIconSetting(getUserSetting(db, userId, ICONS_KEY)) ?? "auto",
  };
}
