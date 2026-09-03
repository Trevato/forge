/**
 * JPEG → RGBA. Baseline *and* progressive, because half the images on a real
 * forge are progressive and "it worked in the test fixture" is not a feature.
 *
 * This is an independent implementation, but the shape is the one every
 * correct decoder converges on and it is worth naming the references rather
 * than pretending otherwise: ITU-T T.81 (the standard itself; Annex F is the
 * entropy coding, Annex G the progressive modes), and the notorious
 * successive-approximation AC state machine as it appears in notmasteryet's
 * jpgjs and in pdf.js's `src/core/jpg.js`. No text is copied from either —
 * the algorithm is read from T.81 §G.1.2.3 and written here in our own terms,
 * with the state machine kept explicit because that is the only way it is
 * legible.
 *
 * What it does: SOF0/SOF1 (baseline/extended sequential Huffman), SOF2
 * (progressive Huffman), 1- and 3-component images, 4:4:4 / 4:2:2 / 4:2:0 and
 * any other integer sampling factor, restart intervals, and EXIF orientation
 * from APP1 (all eight cases, applied to the output).
 *
 * What it refuses, honestly, as `unsupported`: arithmetic coding (SOF9/SOF10,
 * patent-era and vanishingly rare), lossless and hierarchical modes (SOF3,
 * SOF5–7, SOF13–15), 12-bit precision, and 4-component CMYK/YCCK — which
 * needs an ink model we have no business guessing at for a preview.
 */

import { err, ok, type Result } from "../../kernel/result.ts";

export type JpegError = "corrupt" | "unsupported";

export interface JpegImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

export interface JpegHeader {
  readonly width: number;
  readonly height: number;
  readonly progressive: boolean;
  readonly components: number;
  /** 1–8 as EXIF defines it; 1 when absent. */
  readonly orientation: number;
}

/** Zigzag position → natural position in an 8×8 block (T.81 Figure A.6). */
const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40,
  48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
  47, 55, 62, 63,
]);

export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

// ---------------------------------------------------------------------------
// Huffman
// ---------------------------------------------------------------------------

/**
 * A canonical Huffman decoder in the form T.81 §F.2.2.3 specifies: per code
 * length, the smallest code, the largest, and where its values start. Walking
 * it is one compare per bit, which beats a pointer-chasing tree and is a
 * fraction of the memory of a 16-bit lookup table.
 */
interface Huff {
  readonly mincode: Int32Array;
  readonly maxcode: Int32Array;
  readonly valptr: Int32Array;
  readonly values: Uint8Array;
}

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huff {
  const mincode = new Int32Array(17);
  const maxcode = new Int32Array(17).fill(-1);
  const valptr = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    const n = counts[l - 1] ?? 0;
    valptr[l] = k;
    mincode[l] = code;
    if (n === 0) {
      // -1 means "no code is this short", so the decode loop always descends.
      maxcode[l] = -1;
    } else {
      code += n;
      k += n;
      maxcode[l] = code - 1;
    }
    code <<= 1;
  }
  return { mincode, maxcode, valptr, values };
}

// ---------------------------------------------------------------------------
// Entropy-coded bit stream
// ---------------------------------------------------------------------------

class Corrupt extends Error {}

/**
 * The bit reader, with the two rules that make an entropy stream survivable:
 * a 0xFF byte inside the stream is followed by a stuffed 0x00 which is not
 * data, and any other 0xFF pair is a marker — at which point we stop and
 * feed zeros rather than reading the marker as picture. A truncated JPEG
 * should render what it has, which is what every browser does.
 */
class Bits {
  at: number;
  marker = 0;
  private buf = 0;
  private count = 0;

  constructor(
    private readonly data: Uint8Array,
    from: number,
  ) {
    this.at = from;
  }

  bit(): number {
    if (this.count === 0) {
      if (this.marker !== 0 || this.at >= this.data.length) return 0;
      let b = this.data[this.at++]!;
      if (b === 0xff) {
        const next = this.data[this.at] ?? 0xd9;
        if (next === 0x00) this.at++;
        else {
          // Rewind onto the 0xFF so the scan loop can still see the marker:
          // a latched marker means we stop reading, not that we consumed it.
          this.at--;
          this.marker = 0xff00 | next;
          return 0;
        }
      }
      this.buf = b;
      this.count = 8;
    }
    this.count--;
    return (this.buf >> this.count) & 1;
  }

  receive(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  }

  /** T.81 §F.2.2.1 EXTEND: sign-extend an n-bit magnitude. */
  extend(n: number): number {
    if (n === 0) return 0;
    const v = this.receive(n);
    return v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
  }

  decode(h: Huff): number {
    let code = this.bit();
    let l = 1;
    while (code > h.maxcode[l]!) {
      code = (code << 1) | this.bit();
      l++;
      if (l > 16) throw new Corrupt("huffman code longer than 16 bits");
    }
    const v = h.values[h.valptr[l]! + code - h.mincode[l]!];
    if (v === undefined) throw new Corrupt("huffman value out of range");
    return v;
  }

  /** Drop the partial byte and clear any latched marker — restart semantics. */
  restart(): void {
    this.count = 0;
    this.marker = 0;
  }
}

// ---------------------------------------------------------------------------
// Frame model
// ---------------------------------------------------------------------------

interface Component {
  id: number;
  h: number;
  v: number;
  quantId: number;
  /** Blocks of real picture, per row/column. */
  blocksPerLine: number;
  blocksPerColumn: number;
  /** Blocks per row in `blockData` — rounded up to whole MCUs. */
  stride: number;
  blockData: Int16Array;
  huffDc: Huff | undefined;
  huffAc: Huff | undefined;
  pred: number;
  output: Uint8ClampedArray | undefined;
}

interface Frame {
  progressive: boolean;
  width: number;
  height: number;
  maxH: number;
  maxV: number;
  mcusPerLine: number;
  mcusPerColumn: number;
  components: Component[];
}

function blockOffset(c: Component, row: number, col: number): number {
  return 64 * (row * c.stride + col);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const SOF_HUFFMAN = new Set([0xc0, 0xc1, 0xc2]);
const SOF_REFUSED = new Set([
  0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/** Geometry and mode without decoding a single block. */
export function jpegHeader(bytes: Uint8Array): Result<JpegHeader, JpegError> {
  if (!isJpeg(bytes)) return err("corrupt");
  let orientation = 1;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = bytes[at + 1]!;
    if (marker === 0xff || marker === 0x00) {
      at++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9) break;
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    if (length < 2 || at + 2 + length > bytes.length) return err("corrupt");
    const body = bytes.subarray(at + 4, at + 2 + length);
    if (marker === 0xe1) orientation = exifOrientation(body) ?? orientation;
    else if (SOF_REFUSED.has(marker)) return err("unsupported");
    else if (SOF_HUFFMAN.has(marker)) {
      if (body.length < 6) return err("corrupt");
      const precision = body[0]!;
      const height = (body[1]! << 8) | body[2]!;
      const width = (body[3]! << 8) | body[4]!;
      const components = body[5]!;
      if (width === 0 || height === 0) return err("corrupt");
      if (precision !== 8) return err("unsupported");
      if (components !== 1 && components !== 3) return err("unsupported");
      return ok({
        width,
        height,
        progressive: marker === 0xc2,
        components,
        orientation,
      });
    }
    at += 2 + length;
  }
  return err("corrupt");
}

export function decodeJpeg(bytes: Uint8Array): Result<JpegImage, JpegError> {
  try {
    return decodeChecked(bytes);
  } catch (cause) {
    if (cause instanceof Corrupt) return err("corrupt");
    throw cause;
  }
}

function decodeChecked(bytes: Uint8Array): Result<JpegImage, JpegError> {
  if (!isJpeg(bytes)) return err("corrupt");

  const quant: (Int32Array | undefined)[] = new Array(4).fill(undefined);
  const huffDc: (Huff | undefined)[] = new Array(4).fill(undefined);
  const huffAc: (Huff | undefined)[] = new Array(4).fill(undefined);
  let frame: Frame | undefined;
  let resetInterval = 0;
  let orientation = 1;
  /** Adobe APP14 colour transform: 0 means the three channels are RGB. */
  let adobeTransform: number | undefined;

  let at = 2;
  let done = false;
  while (!done && at + 2 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = bytes[at + 1]!;
    at += 2;
    if (marker === 0xff || marker === 0x00) continue;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break;
    if (at + 2 > bytes.length) return err("corrupt");
    const length = (bytes[at]! << 8) | bytes[at + 1]!;
    if (length < 2 || at + length > bytes.length) return err("corrupt");
    const body = bytes.subarray(at + 2, at + length);
    const next = at + length;

    switch (marker) {
      case 0xe1: {
        orientation = exifOrientation(body) ?? orientation;
        break;
      }
      case 0xee: {
        // "Adobe" + version + flags + transform.
        if (
          body.length >= 12 &&
          String.fromCharCode(...body.subarray(0, 5)) === "Adobe"
        )
          adobeTransform = body[11]!;
        break;
      }
      case 0xdb: {
        let i = 0;
        while (i < body.length) {
          const spec = body[i++]!;
          const precision = spec >> 4;
          const id = spec & 15;
          if (id > 3) return err("corrupt");
          const table = new Int32Array(64);
          for (let k = 0; k < 64; k++) {
            if (precision === 0) table[ZIGZAG[k]!] = body[i++] ?? 0;
            else {
              table[ZIGZAG[k]!] = ((body[i] ?? 0) << 8) | (body[i + 1] ?? 0);
              i += 2;
            }
          }
          quant[id] = table;
        }
        break;
      }
      case 0xc4: {
        let i = 0;
        while (i + 17 <= body.length) {
          const spec = body[i++]!;
          const counts = body.subarray(i, i + 16);
          i += 16;
          let total = 0;
          for (const n of counts) total += n;
          if (i + total > body.length) return err("corrupt");
          const values = body.subarray(i, i + total);
          i += total;
          const id = spec & 15;
          if (id > 3) return err("corrupt");
          const built = buildHuffman(counts, values);
          if (spec >> 4 === 0) huffDc[id] = built;
          else huffAc[id] = built;
        }
        break;
      }
      case 0xdd: {
        resetInterval = ((body[0] ?? 0) << 8) | (body[1] ?? 0);
        break;
      }
      case 0xda: {
        if (frame === undefined) return err("corrupt");
        const n = body[0] ?? 0;
        if (n === 0 || 1 + n * 2 + 3 > body.length) return err("corrupt");
        const scan: Component[] = [];
        for (let i = 0; i < n; i++) {
          const id = body[1 + i * 2]!;
          const tables = body[2 + i * 2]!;
          const c = frame.components.find((x) => x.id === id);
          if (c === undefined) return err("corrupt");
          c.huffDc = huffDc[tables >> 4];
          c.huffAc = huffAc[tables & 15];
          scan.push(c);
        }
        const spectralStart = body[1 + n * 2]!;
        const spectralEnd = body[2 + n * 2]!;
        const approx = body[3 + n * 2]!;
        const consumed = decodeScan(
          bytes,
          next,
          frame,
          scan,
          resetInterval,
          spectralStart,
          spectralEnd,
          approx >> 4,
          approx & 15,
        );
        at = consumed;
        continue;
      }
      default: {
        if (SOF_REFUSED.has(marker)) return err("unsupported");
        if (SOF_HUFFMAN.has(marker)) {
          if (frame !== undefined) return err("unsupported"); // hierarchical
          const built = readFrame(body, marker === 0xc2);
          if (!built.ok) return built;
          frame = built.value;
        }
        break;
      }
    }
    at = next;
  }

  if (frame === undefined) return err("corrupt");
  for (const c of frame.components) {
    const q = quant[c.quantId];
    if (q === undefined) return err("corrupt");
    c.output = renderComponent(c, q);
  }
  const rgba = toRgba(frame, adobeTransform);
  return ok(orient(frame.width, frame.height, rgba, orientation));
}

function readFrame(
  body: Uint8Array,
  progressive: boolean,
): Result<Frame, JpegError> {
  if (body.length < 6) return err("corrupt");
  const precision = body[0]!;
  const height = (body[1]! << 8) | body[2]!;
  const width = (body[3]! << 8) | body[4]!;
  const count = body[5]!;
  if (width === 0 || height === 0) return err("corrupt");
  if (precision !== 8) return err("unsupported");
  if (count !== 1 && count !== 3) return err("unsupported");
  if (6 + count * 3 > body.length) return err("corrupt");

  const components: Component[] = [];
  let maxH = 1;
  let maxV = 1;
  for (let i = 0; i < count; i++) {
    const id = body[6 + i * 3]!;
    const sampling = body[7 + i * 3]!;
    const h = sampling >> 4;
    const v = sampling & 15;
    if (h < 1 || h > 4 || v < 1 || v > 4) return err("corrupt");
    maxH = Math.max(maxH, h);
    maxV = Math.max(maxV, v);
    components.push({
      id,
      h,
      v,
      quantId: body[8 + i * 3]!,
      blocksPerLine: 0,
      blocksPerColumn: 0,
      stride: 0,
      blockData: new Int16Array(0),
      huffDc: undefined,
      huffAc: undefined,
      pred: 0,
      output: undefined,
    });
  }

  const mcusPerLine = Math.ceil(width / (8 * maxH));
  const mcusPerColumn = Math.ceil(height / (8 * maxV));
  for (const c of components) {
    c.blocksPerLine = Math.ceil((Math.ceil(width / 8) * c.h) / maxH);
    c.blocksPerColumn = Math.ceil((Math.ceil(height / 8) * c.v) / maxV);
    // The buffer is sized in whole MCUs, so an interleaved scan writing the
    // padding blocks past the right/bottom edge stays in bounds by
    // construction rather than by a bounds check in the inner loop.
    c.stride = mcusPerLine * c.h;
    const rows = mcusPerColumn * c.v;
    c.blockData = new Int16Array(64 * c.stride * rows);
  }
  return ok({
    progressive,
    width,
    height,
    maxH,
    maxV,
    mcusPerLine,
    mcusPerColumn,
    components,
  });
}

// ---------------------------------------------------------------------------
// Scan decoding
// ---------------------------------------------------------------------------

/**
 * One scan. Returns the offset just past the entropy-coded data, so the
 * marker loop resumes where the picture stops — a scan's length is not in its
 * header, it is wherever the next marker turns up.
 */
function decodeScan(
  data: Uint8Array,
  from: number,
  frame: Frame,
  scan: Component[],
  resetInterval: number,
  spectralStart: number,
  spectralEnd: number,
  ah: number,
  al: number,
): number {
  const bits = new Bits(data, from);
  const single = scan.length === 1;
  const first = scan[0]!;
  const total = single
    ? first.blocksPerLine * first.blocksPerColumn
    : frame.mcusPerLine * frame.mcusPerColumn;
  const perRestart = resetInterval > 0 ? resetInterval : total;

  const state: AcState = { eobrun: 0, phase: 0, value: 0, run: 0 };
  let index = 0;
  while (index < total) {
    for (const c of scan) c.pred = 0;
    state.eobrun = 0;
    state.phase = 0;
    state.run = 0;
    const end = Math.min(total, index + perRestart);
    for (; index < end; index++) {
      if (single) {
        const row = Math.floor(index / first.blocksPerLine);
        const col = index % first.blocksPerLine;
        decodeBlock(bits, frame, first, blockOffset(first, row, col), state, {
          spectralStart,
          spectralEnd,
          ah,
          al,
        });
      } else {
        const mcuRow = Math.floor(index / frame.mcusPerLine);
        const mcuCol = index % frame.mcusPerLine;
        for (const c of scan)
          for (let v = 0; v < c.v; v++)
            for (let h = 0; h < c.h; h++)
              decodeBlock(
                bits,
                frame,
                c,
                blockOffset(c, mcuRow * c.v + v, mcuCol * c.h + h),
                state,
                { spectralStart, spectralEnd, ah, al },
              );
      }
    }
    if (index >= total) break;
    // Between restart intervals: byte-align, then step over the RSTn. A
    // stream that lost sync is skipped forward to the next marker rather
    // than abandoned — the rest of the picture is usually fine.
    bits.restart();
    const marker = seekMarker(data, bits.at);
    if (marker === undefined) break;
    if (marker.code >= 0xd0 && marker.code <= 0xd7) bits.at = marker.at + 2;
    else break;
  }
  bits.restart();
  const tail = seekMarker(data, bits.at);
  return tail === undefined ? data.length : tail.at;
}

function seekMarker(
  data: Uint8Array,
  from: number,
): { at: number; code: number } | undefined {
  for (let i = Math.max(0, from); i + 1 < data.length; i++) {
    if (data[i] !== 0xff) continue;
    const code = data[i + 1]!;
    if (code === 0x00 || code === 0xff) continue;
    return { at: i, code };
  }
  return undefined;
}

interface Band {
  readonly spectralStart: number;
  readonly spectralEnd: number;
  readonly ah: number;
  readonly al: number;
}

/** Progressive AC refinement carries state across blocks; this is it. */
interface AcState {
  eobrun: number;
  /** 0 initial, 1 skipping zeroes, 2 skipping to a new value, 3 place it, 4 EOB run. */
  phase: number;
  value: number;
  /** Zero-run still to walk. Lives here because a block can end mid-run. */
  run: number;
}

function decodeBlock(
  bits: Bits,
  frame: Frame,
  c: Component,
  offset: number,
  state: AcState,
  band: Band,
): void {
  if (!frame.progressive) {
    decodeBaseline(bits, c, offset);
    return;
  }
  if (band.spectralStart === 0) {
    if (band.ah === 0) decodeDcFirst(bits, c, offset, band.al);
    else c.blockData[offset] = c.blockData[offset]! | (bits.bit() << band.al);
    return;
  }
  if (band.ah === 0) decodeAcFirst(bits, c, offset, state, band);
  else decodeAcRefine(bits, c, offset, state, band);
}

function decodeBaseline(bits: Bits, c: Component, offset: number): void {
  const dc = c.huffDc;
  const ac = c.huffAc;
  if (dc === undefined || ac === undefined)
    throw new Corrupt("scan references an undefined Huffman table");
  const t = bits.decode(dc);
  c.pred += bits.extend(t);
  c.blockData[offset] = c.pred;
  let k = 1;
  while (k < 64) {
    const rs = bits.decode(ac);
    const s = rs & 15;
    const r = rs >> 4;
    if (s === 0) {
      if (r < 15) break; // EOB
      k += 16;
      continue;
    }
    k += r;
    if (k > 63) break;
    c.blockData[offset + ZIGZAG[k]!] = bits.extend(s);
    k++;
  }
}

function decodeDcFirst(
  bits: Bits,
  c: Component,
  offset: number,
  al: number,
): void {
  const dc = c.huffDc;
  if (dc === undefined) throw new Corrupt("DC scan with no table");
  const t = bits.decode(dc);
  c.pred += bits.extend(t);
  c.blockData[offset] = c.pred << al;
}

function decodeAcFirst(
  bits: Bits,
  c: Component,
  offset: number,
  state: AcState,
  band: Band,
): void {
  if (state.eobrun > 0) {
    state.eobrun--;
    return;
  }
  const ac = c.huffAc;
  if (ac === undefined) throw new Corrupt("AC scan with no table");
  let k = band.spectralStart;
  while (k <= band.spectralEnd) {
    const rs = bits.decode(ac);
    const s = rs & 15;
    const r = rs >> 4;
    if (s === 0) {
      if (r < 15) {
        state.eobrun = bits.receive(r) + (1 << r) - 1;
        return;
      }
      k += 16;
      continue;
    }
    k += r;
    if (k > band.spectralEnd) return;
    c.blockData[offset + ZIGZAG[k]!] = bits.extend(s) * (1 << band.al);
    k++;
  }
}

/**
 * AC successive approximation (T.81 §G.1.2.3). Every already-nonzero
 * coefficient in the band gets one correction bit as we pass over it, and the
 * run-lengths in the stream count only the *zero* coefficients — which is why
 * this is a state machine and not a loop: a single Huffman symbol can leave
 * us mid-run when the block ends.
 */
function decodeAcRefine(
  bits: Bits,
  c: Component,
  offset: number,
  state: AcState,
  band: Band,
): void {
  const ac = c.huffAc;
  if (ac === undefined) throw new Corrupt("AC refinement with no table");
  const delta = 1 << band.al;
  let k = band.spectralStart;
  while (k <= band.spectralEnd) {
    const at = offset + ZIGZAG[k]!;
    const sign = c.blockData[at]! < 0 ? -1 : 1;
    switch (state.phase) {
      case 0: {
        const rs = bits.decode(ac);
        const s = rs & 15;
        state.run = rs >> 4;
        if (s === 0) {
          if (state.run < 15) {
            state.eobrun = bits.receive(state.run) + (1 << state.run);
            state.phase = 4;
          } else {
            state.run = 16;
            state.phase = 1;
          }
        } else {
          if (s !== 1) throw new Corrupt("refinement magnitude must be 1");
          state.value = bits.extend(1);
          state.phase = state.run > 0 ? 2 : 3;
        }
        continue; // re-enter without advancing k
      }
      case 1:
      case 2: {
        if (c.blockData[at] !== 0)
          c.blockData[at] = c.blockData[at]! + sign * (bits.bit() * delta);
        else if (--state.run <= 0) state.phase = state.phase === 2 ? 3 : 0;
        break;
      }
      case 3: {
        if (c.blockData[at] !== 0)
          c.blockData[at] = c.blockData[at]! + sign * (bits.bit() * delta);
        else {
          c.blockData[at] = state.value * delta;
          state.phase = 0;
        }
        break;
      }
      default: {
        if (c.blockData[at] !== 0)
          c.blockData[at] = c.blockData[at]! + sign * (bits.bit() * delta);
        break;
      }
    }
    k++;
  }
  if (state.phase === 4 && --state.eobrun === 0) state.phase = 0;
}

// ---------------------------------------------------------------------------
// Dequantize + IDCT
// ---------------------------------------------------------------------------

// The IJG islow constants, in float. Kept as named values because they are
// cosines, not magic: 0.541196100 = sqrt(2)·cos(3π/8) and so on.
const C_0_298631336 = 0.298631336;
const C_0_390180644 = 0.390180644;
const C_0_541196100 = 0.5411961;
const C_0_765366865 = 0.765366865;
const C_0_899976223 = 0.899976223;
const C_1_175875602 = 1.175875602;
const C_1_501321110 = 1.50132111;
const C_1_847759065 = 1.847759065;
const C_1_961570560 = 1.96157056;
const C_2_053119869 = 2.053119869;
const C_2_562915447 = 2.562915447;
const C_3_072711026 = 3.072711026;

/**
 * Every block of one component, dequantized and inverse-transformed into an
 * 8-bit plane at that component's own resolution.
 *
 * The transform is the separable Loeffler-Ligtenberg-Moschytz butterfly (the
 * one IJG calls `jpeg_idct_islow`), in floating point so there is no
 * fixed-point descaling to get wrong. Each 1-D pass leaves the result scaled
 * by 2√2, so the two passes are undone with a single ÷8 at the end, alongside
 * the +128 level shift.
 */
function renderComponent(c: Component, quant: Int32Array): Uint8ClampedArray {
  const w = c.blocksPerLine * 8;
  const h = c.blocksPerColumn * 8;
  const out = new Uint8ClampedArray(w * h);
  const p = new Float32Array(64);
  for (let br = 0; br < c.blocksPerColumn; br++) {
    for (let bc = 0; bc < c.blocksPerLine; bc++) {
      const offset = blockOffset(c, br, bc);
      for (let i = 0; i < 64; i++) p[i] = c.blockData[offset + i]! * quant[i]!;
      idct(p);
      const top = br * 8;
      const left = bc * 8;
      for (let y = 0; y < 8; y++) {
        const dst = (top + y) * w + left;
        for (let x = 0; x < 8; x++) out[dst + x] = p[y * 8 + x]! / 8 + 128;
      }
    }
  }
  return out;
}

function idct(p: Float32Array): void {
  for (let i = 0; i < 8; i++) idct1d(p, i * 8, 1);
  for (let i = 0; i < 8; i++) idct1d(p, i, 8);
}

function idct1d(p: Float32Array, base: number, step: number): void {
  const s0 = p[base]!;
  const s1 = p[base + step]!;
  const s2 = p[base + step * 2]!;
  const s3 = p[base + step * 3]!;
  const s4 = p[base + step * 4]!;
  const s5 = p[base + step * 5]!;
  const s6 = p[base + step * 6]!;
  const s7 = p[base + step * 7]!;

  // Even part.
  let z1 = (s2 + s6) * C_0_541196100;
  const e2 = z1 - s6 * C_1_847759065;
  const e3 = z1 + s2 * C_0_765366865;
  const e0 = s0 + s4;
  const e1 = s0 - s4;
  const t10 = e0 + e3;
  const t13 = e0 - e3;
  const t11 = e1 + e2;
  const t12 = e1 - e2;

  // Odd part: inputs are s7, s5, s3, s1 in that order.
  let o0 = s7;
  let o1 = s5;
  let o2 = s3;
  let o3 = s1;
  z1 = o0 + o3;
  let z2 = o1 + o2;
  let z3 = o0 + o2;
  let z4 = o1 + o3;
  const z5 = (z3 + z4) * C_1_175875602;
  o0 *= C_0_298631336;
  o1 *= C_2_053119869;
  o2 *= C_3_072711026;
  o3 *= C_1_501321110;
  z1 *= -C_0_899976223;
  z2 *= -C_2_562915447;
  z3 = z5 - z3 * C_1_961570560;
  z4 = z5 - z4 * C_0_390180644;
  o0 += z1 + z3;
  o1 += z2 + z4;
  o2 += z2 + z3;
  o3 += z1 + z4;

  p[base] = t10 + o3;
  p[base + step * 7] = t10 - o3;
  p[base + step] = t11 + o2;
  p[base + step * 6] = t11 - o2;
  p[base + step * 2] = t12 + o1;
  p[base + step * 5] = t12 - o1;
  p[base + step * 3] = t13 + o0;
  p[base + step * 4] = t13 - o0;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

function toRgba(frame: Frame, adobeTransform: number | undefined): Uint8Array {
  const { width, height, maxH, maxV } = frame;
  const rgba = new Uint8Array(width * height * 4);
  const grey = frame.components.length === 1;
  // A three-channel JPEG is YCbCr unless Adobe says transform 0, or the SOF
  // component ids literally spell R, G, B — the two ways an encoder declares
  // untransformed colour.
  const ids = frame.components.map((c) => c.id);
  const rgbDirect =
    !grey &&
    (adobeTransform === 0 ||
      (ids[0] === 0x52 && ids[1] === 0x47 && ids[2] === 0x42));

  const planes = frame.components.map((c) => ({
    data: c.output ?? new Uint8ClampedArray(0),
    stride: c.blocksPerLine * 8,
    h: c.h,
    v: c.v,
  }));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      const p0 = planes[0]!;
      // Nearest-neighbour chroma upsampling. Bilinear would be prettier at
      // 4:2:0; at the sizes a terminal shows, nobody can tell.
      const s0 =
        p0.data[
          Math.floor((y * p0.v) / maxV) * p0.stride +
            Math.floor((x * p0.h) / maxH)
        ] ?? 0;
      if (grey) {
        rgba[out] = s0;
        rgba[out + 1] = s0;
        rgba[out + 2] = s0;
        rgba[out + 3] = 255;
        continue;
      }
      const p1 = planes[1]!;
      const p2 = planes[2]!;
      const s1 =
        p1.data[
          Math.floor((y * p1.v) / maxV) * p1.stride +
            Math.floor((x * p1.h) / maxH)
        ] ?? 0;
      const s2 =
        p2.data[
          Math.floor((y * p2.v) / maxV) * p2.stride +
            Math.floor((x * p2.h) / maxH)
        ] ?? 0;
      if (rgbDirect) {
        rgba[out] = s0;
        rgba[out + 1] = s1;
        rgba[out + 2] = s2;
      } else {
        const cb = s1 - 128;
        const cr = s2 - 128;
        rgba[out] = clamp8(s0 + 1.402 * cr);
        rgba[out + 1] = clamp8(s0 - 0.344136 * cb - 0.714136 * cr);
        rgba[out + 2] = clamp8(s0 + 1.772 * cb);
      }
      rgba[out + 3] = 255;
    }
  }
  return rgba;
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

// ---------------------------------------------------------------------------
// EXIF orientation
// ---------------------------------------------------------------------------

/**
 * Tag 0x0112 out of IFD0 in an APP1 "Exif\0\0" payload. A phone photo is
 * almost always stored landscape with an orientation tag, so skipping this
 * would show a sideways preview for the most common image on any forge.
 */
export function exifOrientation(app1: Uint8Array): number | undefined {
  if (app1.length < 14) return undefined;
  if (String.fromCharCode(...app1.subarray(0, 4)) !== "Exif") return undefined;
  const tiff = 6;
  const b0 = app1[tiff];
  const b1 = app1[tiff + 1];
  const little = b0 === 0x49 && b1 === 0x49;
  if (!little && !(b0 === 0x4d && b1 === 0x4d)) return undefined;
  const view = new DataView(app1.buffer, app1.byteOffset, app1.byteLength);
  if (view.getUint16(tiff + 2, little) !== 42) return undefined;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > app1.length) return undefined;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > app1.length) return undefined;
    if (view.getUint16(entry, little) !== 0x0112) continue;
    const value = view.getUint16(entry + 8, little);
    return value >= 1 && value <= 8 ? value : undefined;
  }
  return undefined;
}

/**
 * Apply an EXIF orientation to an RGBA buffer. 1 is a no-op; 5–8 transpose,
 * so the reported width and height swap with them.
 */
export function orient(
  width: number,
  height: number,
  rgba: Uint8Array,
  orientation: number,
): JpegImage {
  if (orientation <= 1 || orientation > 8) return { width, height, rgba };
  const swap = orientation >= 5;
  const w = swap ? height : width;
  const h = swap ? width : height;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let nx: number;
      let ny: number;
      switch (orientation) {
        case 2:
          nx = width - 1 - x;
          ny = y;
          break;
        case 3:
          nx = width - 1 - x;
          ny = height - 1 - y;
          break;
        case 4:
          nx = x;
          ny = height - 1 - y;
          break;
        case 5:
          nx = y;
          ny = x;
          break;
        case 6:
          nx = height - 1 - y;
          ny = x;
          break;
        case 7:
          nx = height - 1 - y;
          ny = width - 1 - x;
          break;
        default:
          nx = y;
          ny = width - 1 - x;
          break;
      }
      const src = (y * width + x) * 4;
      const dst = (ny * w + nx) * 4;
      out[dst] = rgba[src]!;
      out[dst + 1] = rgba[src + 1]!;
      out[dst + 2] = rgba[src + 2]!;
      out[dst + 3] = rgba[src + 3]!;
    }
  }
  return { width: w, height: h, rgba: out };
}
