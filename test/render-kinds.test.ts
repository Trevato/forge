/**
 * The registry of file kinds and the byte-range reader, as plain data: every
 * extension the registry names lands on its kind, a name its bytes
 * contradict falls back, and a Range header reads as the window it asks for.
 */

import { describe, expect, test } from "bun:test";
import { parseRange } from "../src/http/range.ts";
import { fileKind, KNOWN_EXTENSIONS, mediaType, type FileKind } from "../src/web/render/kinds.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const of = (...b: number[]): Uint8Array => new Uint8Array(b);
const box = (brand: string): Uint8Array => enc(`\0\0\0\x20ftyp${brand}`);

/** One true head per extension, and the kind and type it must come back as. */
const SAMPLES: Record<string, [Uint8Array, FileKind, string]> = {
  png: [of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0), "image", "image/png"],
  jpg: [of(0xff, 0xd8, 0xff, 0xe0), "image", "image/jpeg"],
  jpeg: [of(0xff, 0xd8, 0xff, 0xe1), "image", "image/jpeg"],
  gif: [enc("GIF89a\0"), "image", "image/gif"],
  webp: [enc("RIFF\0\0\0\0WEBPVP8 "), "image", "image/webp"],
  avif: [box("avif"), "image", "image/avif"],
  bmp: [enc("BM\0\0"), "image", "image/bmp"],
  ico: [of(0, 0, 1, 0, 1), "image", "image/x-icon"],
  svg: [enc('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'), "svg", "image/svg+xml"],
  pdf: [enc("%PDF-1.7\n"), "pdf", "application/pdf"],
  mp3: [enc("ID3\x04\0"), "audio", "audio/mpeg"],
  ogg: [enc("OggS\0"), "audio", "audio/ogg"],
  oga: [enc("OggS\0"), "audio", "audio/ogg"],
  wav: [enc("RIFF\0\0\0\0WAVEfmt "), "audio", "audio/wav"],
  flac: [enc("fLaC\0"), "audio", "audio/flac"],
  m4a: [box("M4A "), "audio", "audio/mp4"],
  aac: [of(0xff, 0xf1, 0x50, 0x80), "audio", "audio/aac"],
  mp4: [box("isom"), "video", "video/mp4"],
  m4v: [box("M4V "), "video", "video/mp4"],
  webm: [of(0x1a, 0x45, 0xdf, 0xa3, 0), "video", "video/webm"],
  mov: [box("qt  "), "video", "video/quicktime"],
  stl: [enc("solid cube\n"), "model3d", "model/stl"],
  glb: [enc("glTF\x02\0\0\0"), "model3d", "model/gltf-binary"],
  csv: [enc("a,b\n1,2\n"), "csv", "application/octet-stream"],
  tsv: [enc("a\tb\n"), "csv", "application/octet-stream"],
  gltf: [enc('{"asset":{}}'), "model3d", "application/octet-stream"],
  json: [enc("{}"), "config", "application/octet-stream"],
  jsonc: [enc("{}"), "config", "application/octet-stream"],
  yaml: [enc("a: 1\n"), "config", "application/octet-stream"],
  yml: [enc("a: 1\n"), "config", "application/octet-stream"],
  toml: [enc("a = 1\n"), "config", "application/octet-stream"],
  ini: [enc("[a]\n"), "config", "application/octet-stream"],
  conf: [enc("a 1\n"), "config", "application/octet-stream"],
  zip: [of(0x50, 0x4b, 3, 4, 0), "archive", "application/octet-stream"],
  tar: [enc("x".repeat(257) + "ustar\0"), "archive", "application/octet-stream"],
  tgz: [of(0x1f, 0x8b, 8), "archive", "application/octet-stream"],
  md: [enc("# a\n"), "markdown", "application/octet-stream"],
  markdown: [enc("# a\n"), "markdown", "application/octet-stream"],
  mdx: [enc("# a\n"), "markdown", "application/octet-stream"],
};

describe("the registry of file kinds", () => {
  test("every extension it names maps to its kind and its one media type", () => {
    expect(KNOWN_EXTENSIONS.length).toBeGreaterThan(0);
    for (const ext of KNOWN_EXTENSIONS) {
      const sample = SAMPLES[ext];
      expect(sample, `a sample for .${ext}`).toBeDefined();
      const [head, kind, type] = sample!;
      expect([ext, fileKind(`dir/file.${ext}`, head)]).toEqual([ext, kind]);
      expect([ext, mediaType(`dir/FILE.${ext.toUpperCase()}`, head)]).toEqual([ext, type]);
    }
  });

  test("a name the bytes contradict falls back to octet-stream and to what the bytes are", () => {
    expect(mediaType("logo.png", enc("not a png"))).toBe("application/octet-stream");
    expect(fileKind("logo.png", enc("not a png"))).toBe("text");
    expect(mediaType("clip.mp4", of(0, 1, 2, 0))).toBe("application/octet-stream");
    expect(fileKind("clip.mp4", of(0, 1, 2, 0))).toBe("binary");
    // A PNG wearing another format's name is still not served as that format.
    const png = SAMPLES.png![0];
    expect(mediaType("photo.jpg", png)).toBe("application/octet-stream");
    // An SVG with no root element is not an SVG.
    expect(mediaType("x.svg", enc("<html><script>1</script></html>"))).toBe(
      "application/octet-stream",
    );
  });

  test("nothing it can answer is HTML or script", () => {
    for (const ext of [...KNOWN_EXTENSIONS, "html", "htm", "js", "mjs", "xhtml", "xml"]) {
      const head = SAMPLES[ext]?.[0] ?? enc("<script>alert(1)</script>");
      const type = mediaType(`a.${ext}`, head);
      expect(type).not.toMatch(/html|javascript|ecmascript|xml(?!$)/);
      expect(type).not.toBe("text/html");
    }
    expect(mediaType("index.html", enc("<html>"))).toBe("application/octet-stream");
  });

  test("a file with no known extension is text or binary by its bytes", () => {
    expect(fileKind("Makefile", enc("all:\n"))).toBe("text");
    expect(fileKind("src/a.ts", enc("export {}\n"))).toBe("text");
    expect(fileKind("blob.dat", of(1, 0, 2))).toBe("binary");
    expect(fileKind(".png", SAMPLES.png![0])).toBe("binary");
  });
});

describe("a byte range", () => {
  test("a single range, clamped to the file", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-200", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
  });

  test("a suffix range is the last N bytes", () => {
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
  });

  test("past the end is unsatisfiable", () => {
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
  });

  test("anything else is the whole file", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
    expect(parseRange("bytes=9-1", 100)).toBeNull();
    expect(parseRange("bytes=-", 100)).toBeNull();
    expect(parseRange("bytes=99999999999999999999-", 100)).toBeNull();
  });
});
