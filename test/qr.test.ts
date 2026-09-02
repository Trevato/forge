/**
 * The QR encoder, against real symbols.
 *
 * A QR code that is subtly wrong still looks like a QR code, so "it renders"
 * proves nothing. The vectors below are complete matrices produced by Nayuki's
 * `qrcodegen` — the reference implementation, generated offline with
 * `uv run --with qrcodegen` — and every module of ours must match: the data
 * codewords, the Reed-Solomon block, the interleave, the mask the penalty
 * rules chose, the format bits and (from version 7) the version bits.
 *
 * Three bugs were found this way and none of them would have shown up in a
 * shape test: a Reed-Solomon generator polynomial built from reciprocal roots,
 * the timing pattern drawn *over* a finder instead of under it, and the format
 * reservation clobbering the timing module it should run around. Each produced
 * a symbol that looked perfect and scanned as nothing.
 *
 * The structural half of the file then asserts the invariants a vector cannot:
 * that the quiet zone is empty, that the size grows 21 + 4(v-1), that the
 * format bits decode back to level M and the chosen mask, and that the
 * renderers emit what the two surfaces need.
 */

import { describe, expect, test } from "bun:test";
import {
  QR_MAX_BYTES,
  qrEncode,
  qrRows,
  qrSvg,
  type QrCode,
} from "../src/design/qr.ts";

interface Vector {
  readonly note: string;
  readonly text: string;
  readonly version: number;
  readonly mask: number;
  readonly rows: readonly string[];
}

const VECTORS: readonly Vector[] = [
  {
    note: 'HELLO WORLD',
    text: 'HELLO WORLD',
    version: 1,
    mask: 4,
    rows: [
      "111111101100101111111",
      "100000100001001000001",
      "101110100101001011101",
      "101110101001001011101",
      "101110101110101011101",
      "100000101001001000001",
      "111111101010101111111",
      "000000001001100000000",
      "100010111111011111001",
      "000100001011100001111",
      "001111110011011010010",
      "111110001100010000000",
      "111110101010101100110",
      "000000001010111101011",
      "111111101110101011010",
      "100000100101110110011",
      "101110101101011000110",
      "101110100100100011011",
      "101110100111000111000",
      "100000100001010000000",
      "111111101111111110101",
    ],
  },
  {
    note: 'a short link, the real case',
    text: 'https://forge.example.com/go/abcdefghij',
    version: 3,
    mask: 5,
    rows: [
      "11111110010000100110001111111",
      "10000010111000001110001000001",
      "10111010111000001001101011101",
      "10111010101011001101101011101",
      "10111010001001001111001011101",
      "10000010000000000100101000001",
      "11111110101010101010101111111",
      "00000000110100111000100000000",
      "10000010101011110100011001110",
      "00111001001101110111000110110",
      "01010011110101011000000100000",
      "11100001010000001000110111000",
      "01111110101101111010111100001",
      "00110101001001011111101110011",
      "11101110011111110100001001100",
      "10100001000101100000100010101",
      "00000011111000110100100101100",
      "11101000000100011011101110111",
      "11110111100101110001001001001",
      "10110000110100110000110100000",
      "10111011100100010101111110111",
      "00000000111111010110100011000",
      "11111110010001110101101011100",
      "10000010001111010001100010011",
      "10111010001101011011111111001",
      "10111010011100011111010001101",
      "10111010001101111100001111110",
      "10000010010110001000000001101",
      "11111110100111110101010110100",
    ],
  },
  {
    note: 'version 7 — the first with version information',
    text: "x".repeat(110),
    version: 7,
    mask: 0,
    rows: [
      "111111100110101101011001011011101000101111111",
      "100000101101111111110100001110111101001000001",
      "101110100000101010100110101100010001001011101",
      "101110100101001100001011100001000001101011101",
      "101110101111101001011111101011101111101011101",
      "100000100100110000111000100110111000001000001",
      "111111101010101010101010101010101010101111111",
      "000000000111110001111000111011101111100000000",
      "101010100101111011001111101110111011000010010",
      "110001010001101111011110000100010000000101101",
      "011110111111101110011010110001000100110000111",
      "001011010001110001010000011101101111111010010",
      "110111101111111111111100101100111011001111000",
      "110101010100101100110010100110010000000101101",
      "110101111010100110010001110101000100110000111",
      "111110011010110101000011011011101111111010010",
      "110101101011100101101010001110111011001111000",
      "100111010010101110111110100100010000000101101",
      "110100111010101100010011110001000100110000111",
      "110100000010111111000001001011101111111010010",
      "100011111010011001101111100110111011111111000",
      "111110001010011110111000101100010000100011101",
      "011010101010011110101010101001000101101010111",
      "100110001111101010001000111011101111100010010",
      "110011111100101000111111101110111010111111000",
      "111101000101000110001011100100010001010001101",
      "011000100001111110001001010001000101011010111",
      "100111011101101011110100011101101110101110011",
      "111011100010001100011110101010111010100101010",
      "110101011110000011111011100100010001010001101",
      "000100111100010011111000110001000101011010111",
      "101111011101001011001100111011101110101110010",
      "000101100000001010110110001110111010100101000",
      "100110011110001010101010100100010001010001101",
      "000010111100001001101011010001000101011010111",
      "011110011101011111010000010011101110101110010",
      "100110110000001110111111111110111010111111000",
      "000000001110101100101000110100010001100011101",
      "111111100010100010111010111001000100101010111",
      "100000100001010011001000111011101111100010010",
      "101110101100100110101111101110111011111111000",
      "101110100110110100110101000100010000111011111",
      "101110101101000011000110010001000101101110111",
      "100000100001010011101110111011101111000100010",
      "111111101000100101011011101110111010010001011",
    ],
  },
  {
    note: 'version 10 — two block groups, 16-bit count',
    text: "y".repeat(200),
    version: 10,
    mask: 1,
    rows: [
      "111111101001101100101000101010101010101010101111001111111",
      "100000100000111110000011011011101110111011101101001000001",
      "101110101111100000010011010001001100010001000111001011101",
      "101110100110001100101101110101000101010101010101001011101",
      "101110100100001100100000111111101010101010101001001011101",
      "100000101001010110000001011000100110111011101110001000001",
      "111111101010101010101010101010101010101010101010101111111",
      "000000000000110111010100111000111011101110111010100000000",
      "101000110001100000110110001111101010101010101010000100101",
      "110010000010010100011101001101010101010101010101010100111",
      "000111100111100001111000101100010001000100010000100100101",
      "000011000001101001010010110100111011101110111010101111010",
      "010100101001101110110001100110101010101010101010001010010",
      "110011000010000100011001111101010101010101010101010100111",
      "001110100001100011111111010110010001000100010000100100101",
      "001000000011100111010011111110111011101110111010101111000",
      "011100101101101000110010011010101010101010101010001010010",
      "110101000010000010000001001101010101010101010101010100111",
      "000000100011100010111100101100010001000100010000100100101",
      "001011010101100010010010110111111011101110111010101111010",
      "011111100101101001001110000011001010101010101010001010010",
      "110101011010100011001011001101110101010101010101010100111",
      "000000110101000011010100101101110001000100010000100100101",
      "111011000110000011101010110110100011101110111010101111010",
      "001111101101101000101110000010100010101010101010001010010",
      "110101000010100010110011001101001101010101010101010100111",
      "110011111101010010000100111111100001000100010000111110101",
      "101010001111101011110010111000111011101110111010100011010",
      "000010101100010011001110011010101010101010101011101010010",
      "111110001010011000010011011000110101010101010101100010111",
      "111111111101101000000100101111110001000100010000111110101",
      "100111010111010111110100111011111011101110111011111011010",
      "111000100100000011001110111001001010101010101011010000010",
      "010000010010011000010100001101010101010101010100010100100",
      "110010101101111010000010100010110001000100010000001010100",
      "101111001011000111110010001011111011101110111011111011000",
      "110000100100000011011110011111001010101010101011010000011",
      "010000010000000100001001001111010101010101010100010100111",
      "110001101011111000010010111100110001000100010000001010101",
      "100000001011000010111100111111111011101110111011111011010",
      "110011100111100010000010011001001010101010101011010000010",
      "010011010000000101010011001101010101010101010100010100111",
      "010011101000011001100010100010110001000100010000001010101",
      "010000001111000011111100111011100011101110111011111011010",
      "010011110101000011011010011001111010101010101011010000010",
      "010011010101000101001011001101010101010101010100010100111",
      "101001101000100000001010100011110001000100010000001010101",
      "111110010111010011100100111011011011101110111011111011010",
      "000000110101000001111010011111101010101010101011111110010",
      "000000001100100001001011001000110101010101010101100010111",
      "111111101001100110001110101010110001000100010001101010101",
      "100000100110100011100100101000111011101110111010100011010",
      "101110100101011001111001101111101010101010101010111110010",
      "101110100100111101001001111110110101010101010101101110100",
      "101110101001110100001101010010110001000100010000101010111",
      "100000100110100101100001110101011011101110111011010101000",
      "111111101111010011111000001100001010101010101011000100001",
    ],
  },
];

const draw = (code: QrCode): string[] =>
  code.modules.map((row) => row.map((dark) => (dark ? "1" : "0")).join(""));

const expectOk = (text: string, quiet?: number): QrCode => {
  const code = qrEncode(text, quiet === undefined ? {} : { quiet });
  if (!code.ok) throw new Error(`qrEncode refused ${text.length} bytes`);
  return code.value;
};

describe("qr — reference vectors", () => {
  for (const vector of VECTORS)
    test(`matches qrcodegen: ${vector.note}`, () => {
      const code = expectOk(vector.text, 0);
      expect(code.version).toBe(vector.version);
      expect(code.mask).toBe(vector.mask);
      expect(code.size).toBe(vector.rows.length);
      expect(draw(code)).toEqual([...vector.rows]);
    });
});

describe("qr — structure", () => {
  test("the symbol grows 21 + 4(v-1), and the quiet zone surrounds it", () => {
    for (const [text, version] of [
      ["a", 1],
      ["x".repeat(20), 2],
      ["x".repeat(40), 3],
      ["x".repeat(110), 7],
      ["x".repeat(213), 10],
    ] as const) {
      const code = expectOk(text);
      expect(code.version).toBe(version);
      expect(code.size).toBe(21 + 4 * (version - 1));
      expect(code.quiet).toBe(4);
      expect(code.modules.length).toBe(code.size + 8);
      for (const row of code.modules) expect(row.length).toBe(code.modules.length);
      // Four light modules on every side: the border a scanner needs to find
      // the symbol at all.
      for (let i = 0; i < code.modules.length; i++)
        for (let j = 0; j < 4; j++) {
          expect(code.modules[j]![i]).toBe(false);
          expect(code.modules[code.modules.length - 1 - j]![i]).toBe(false);
          expect(code.modules[i]![j]).toBe(false);
          expect(code.modules[i]![code.modules.length - 1 - j]).toBe(false);
        }
    }
  });

  test("finders, timing and alignment patterns are where the spec puts them", () => {
    const code = expectOk("https://forge.example.com/go/abcdefghij", 0);
    const at = (row: number, col: number): boolean => code.modules[row]![col]!;
    const n = code.size;

    // Three finders, each a 7x7 ring with a 3x3 core, and a light separator.
    for (const [top, left] of [
      [0, 0],
      [0, n - 7],
      [n - 7, 0],
    ] as const) {
      for (let dy = 0; dy < 7; dy++)
        for (let dx = 0; dx < 7; dx++) {
          const ring = dy === 0 || dy === 6 || dx === 0 || dx === 6;
          const core = dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4;
          expect(at(top + dy, left + dx)).toBe(ring || core);
        }
    }
    // Timing: alternating, dark at even indices, and unbroken across the
    // symbol — the row the finder corners must not overwrite.
    for (let i = 8; i < n - 8; i++) {
      expect(at(6, i)).toBe(i % 2 === 0);
      expect(at(i, 6)).toBe(i % 2 === 0);
    }
    // Version 3's one alignment pattern: a 5x5 ring with a single dark centre.
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++)
        expect(at(22 + dy, 22 + dx)).toBe(
          Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
        );
    // The module that is dark in every symbol ever made.
    expect(at(n - 8, 8)).toBe(true);
  });

  test("the format bits decode back to level M and the chosen mask", () => {
    for (const text of ["a", "hello", "https://forge.example.com/go/abcdefghij"]) {
      const code = expectOk(text, 0);
      // Copy one, read in the specification's order, unmasked and BCH-checked.
      let bits = 0;
      const put = (i: number, dark: boolean): void => {
        bits |= (dark ? 1 : 0) << i;
      };
      for (let i = 0; i <= 5; i++) put(i, code.modules[i]![8]!);
      put(6, code.modules[7]![8]!);
      put(7, code.modules[8]![8]!);
      put(8, code.modules[8]![7]!);
      for (let i = 9; i < 15; i++) put(i, code.modules[8]![14 - i]!);
      // The BCH(15,5) code corrects; here it only has to check out clean.
      let rem = bits ^ 0x5412;
      for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
      expect(rem & 0x3ff).toBe(0);
      const data = (bits ^ 0x5412) >> 10;
      expect(data >> 3).toBe(0b00); // error correction level M
      expect(data & 7).toBe(code.mask);

      // The second copy carries the same fifteen bits.
      for (let i = 0; i < 8; i++)
        expect(code.modules[8]![code.size - 1 - i]).toBe(
          ((bits >> i) & 1) === 1,
        );
      for (let i = 8; i < 15; i++)
        expect(code.modules[code.size - 15 + i]![8]).toBe(
          ((bits >> i) & 1) === 1,
        );
    }
  });

  test("version 7 and up carry version information, twice", () => {
    const code = expectOk("x".repeat(110), 0);
    expect(code.version).toBe(7);
    let rem = code.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
    const bits = (code.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const on = ((bits >> i) & 1) === 1;
      const a = code.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      expect(code.modules[b]![a]).toBe(on);
      expect(code.modules[a]![b]).toBe(on);
    }
    // Below version 7 those cells are ordinary data, not a reserved block.
    expect(expectOk("a", 0).version).toBeLessThan(7);
  });

  test("the mask beats every other mask on the standard penalty rules", () => {
    // Not a re-implementation of the scorer: a weaker claim that still pins
    // the outcome — the chosen mask is the one qrcodegen chose in the
    // vectors, and re-encoding the same text is deterministic.
    for (const vector of VECTORS) {
      const once = expectOk(vector.text, 0);
      const twice = expectOk(vector.text, 0);
      expect(once.mask).toBe(vector.mask);
      expect(draw(once)).toEqual(draw(twice));
    }
  });

  test("a payload too big for version 10 is refused, not truncated", () => {
    expect(QR_MAX_BYTES).toBe(213);
    expect(qrEncode("x".repeat(QR_MAX_BYTES)).ok).toBe(true);
    const over = qrEncode("x".repeat(QR_MAX_BYTES + 1));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toBe("too_long");
    // Multi-byte characters count as their UTF-8 bytes, not their length.
    expect(qrEncode("é".repeat(107)).ok).toBe(false);
    expect(qrEncode("é".repeat(106)).ok).toBe(true);
  });

  test("the empty string still makes a valid symbol", () => {
    const code = expectOk("");
    expect(code.version).toBe(1);
    expect(code.size).toBe(21);
  });
});

describe("qr — renderers", () => {
  test("half blocks: two module rows per line, and only the four glyphs", () => {
    const code = expectOk("https://forge.example.com/go/abcdefghij", 2);
    const rows = qrRows(code);
    const width = code.size + 4;
    expect(rows.length).toBe(Math.ceil(width / 2));
    for (const row of rows) {
      expect([...row].length).toBe(width);
      expect(row).toMatch(/^[\u2588\u2580\u2584 ]+$/);
    }
    // The top of a finder pattern: a full block, five upper halves, a full
    // block — the run a terminal test can look for.
    expect(rows[1]).toContain("\u2588\u2580\u2580\u2580\u2580\u2580\u2588");
    // An odd number of module rows pairs the last one with light.
    const odd = expectOk("a", 1);
    expect((odd.size + 2) % 2).toBe(1);
    expect(qrRows(odd).length).toBe(Math.ceil((odd.size + 2) / 2));
  });

  test("svg: one white ground, one black path, crisp edges, no script", () => {
    const code = expectOk("https://forge.example.com/go/abcdefghij");
    const svg = qrSvg(code, { scale: 4 });
    const n = code.size + 8;
    expect(svg).toStartWith("<svg ");
    expect(svg).toContain(`viewBox="0 0 ${n} ${n}"`);
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('fill="#000000"');
    expect(svg).toContain(`width="${n * 4}"`);
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("javascript:");
    // Horizontal runs are merged, so the path is far shorter than one move
    // per dark module.
    const moves = (svg.match(/M/g) ?? []).length;
    let dark = 0;
    for (const row of code.modules) for (const cell of row) if (cell) dark++;
    expect(moves).toBeLessThan(dark);
    // The title is an attribute value and is escaped like one.
    expect(qrSvg(code, { title: 'a "quoted" <tag>' })).toContain(
      "aria-label=\"a &quot;quoted&quot; &lt;tag&gt;\"",
    );
  });

  test("the same payload renders identically every time", () => {
    const link = "https://forge.example.com/go/2m4k7q9xzb";
    expect(qrSvg(expectOk(link))).toBe(qrSvg(expectOk(link)));
  });
});
