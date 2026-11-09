/** Archives listed, not unpacked: zip, tar, tar.gz, and the limits on each. */
import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { ENTRY_CAP, listArchive } from "../src/web/render/archive.ts";
import { archive } from "../src/web/render/archive-view.ts";
import { fileKind } from "../src/web/render/kinds.ts";
import { rendererFor, RENDERERS } from "../src/web/render/renderers.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

interface F { name: string; size?: number; dir?: boolean }

/** A zip with only a central directory, as the lister reads it. */
function zip(files: F[], flags = 0): Uint8Array {
  const dosDate = ((2026 - 1980) << 9) | (11 << 5) | 9;
  const dosTime = (12 << 11) | (30 << 5);
  const central: Uint8Array[] = [];
  for (const f of files) {
    const name = enc(f.name);
    const h = new Uint8Array(46);
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(8, flags, true);
    v.setUint16(12, dosTime, true);
    v.setUint16(14, dosDate, true);
    v.setUint32(24, f.size ?? 0, true);
    v.setUint16(28, name.length, true);
    central.push(cat(h, name));
  }
  const dir = cat(...central);
  const local = enc("PK\x03\x04");
  const e = new Uint8Array(22);
  const v = new DataView(e.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, files.length, true);
  v.setUint16(10, files.length, true);
  v.setUint32(12, dir.length, true);
  v.setUint32(16, local.length, true);
  return cat(local, dir, e);
}

function tarHeader(name: string, size: number, type = "0"): Uint8Array {
  const h = new Uint8Array(512);
  h.set(enc(name), 0);
  h.set(enc(size.toString(8).padStart(11, "0")), 124);
  h.set(enc(Math.floor(Date.UTC(2026, 10, 9, 12, 30) / 1000).toString(8).padStart(11, "0")), 136);
  h.set(enc("        "), 148);
  h[156] = type.charCodeAt(0);
  h.set(enc("ustar\x0000"), 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.set(enc(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  return h;
}
function tar(files: F[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const f of files) {
    const size = f.dir ? 0 : (f.size ?? 0);
    parts.push(tarHeader(f.name, size, f.dir ? "5" : "0"));
    parts.push(new Uint8Array(Math.ceil(size / 512) * 512));
  }
  parts.push(new Uint8Array(1024));
  return cat(...parts);
}

const ok = (r: ReturnType<typeof listArchive>) => {
  if ("error" in r) throw new Error(r.error);
  return r;
};

describe("archive lists", () => {
  test("a zip: sorted by path, sizes summed, DOS date read", () => {
    const r = ok(listArchive(zip([{ name: "b.txt", size: 20 }, { name: "a/", dir: true }, { name: "a/c.txt", size: 5 }])));
    expect(r.format).toBe("zip");
    expect(r.entries.map((e) => e.path)).toEqual(["a/", "a/c.txt", "b.txt"]);
    expect(r.entries[0]!.dir).toBe(true);
    expect(r.count).toBe(3);
    expect(r.bytes).toBe(25);
    expect(r.entries[2]!.mtime?.toISOString()).toBe("2026-11-09T12:30:00.000Z");
  });
  test("a tar: headers read, directories have no size", () => {
    const r = ok(listArchive(tar([{ name: "src", dir: true }, { name: "src/x.ts", size: 700 }])));
    expect(r.format).toBe("tar");
    expect(r.entries.map((e) => [e.path, e.size, e.dir])).toEqual([["src/", 0, true], ["src/x.ts", 700, false]]);
    expect(r.bytes).toBe(700);
    expect(r.entries[1]!.mtime?.toISOString()).toBe("2026-11-09T12:30:00.000Z");
  });
  test("a tar.gz: inflated in memory, then read as tar", () => {
    const r = ok(listArchive(gzipSync(tar([{ name: "a.txt", size: 3 }]))));
    expect(r.format).toBe("tar.gz");
    expect(r.entries.map((e) => e.path)).toEqual(["a.txt"]);
  });
});

describe("archive limits", () => {
  test("a truncated zip says why instead of failing", () => {
    const z = zip([{ name: "a", size: 1 }]);
    const r = listArchive(z.subarray(0, z.length - 10));
    expect("error" in r && r.error).toMatch(/damaged or cut short/);
  });
  test("an encrypted zip is not listed", () => {
    const r = listArchive(zip([{ name: "a" }], 1));
    expect("error" in r && r.error).toMatch(/encrypted/);
  });
  test("a corrupt tar header fails its checksum", () => {
    const t = tar([{ name: "a", size: 1 }]);
    t[0] = 0x7a;
    expect("error" in listArchive(t)).toBe(true);
  });
  test("a gzip bomb stops at the cap", () => {
    const bomb = gzipSync(new Uint8Array(8 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(20_000);
    const r = listArchive(bomb, { cap: 1024 * 1024 });
    expect("error" in r && r.error).toMatch(/unpacks to more than/);
  });
  test("more than 2,000 entries: the first 2,000, and the rest counted", () => {
    const files = Array.from({ length: ENTRY_CAP + 25 }, (_, i) => ({ name: `f${i}`, size: 1 }));
    const r = ok(listArchive(zip(files)));
    expect(r.entries.length).toBe(ENTRY_CAP);
    expect(r.count).toBe(ENTRY_CAP + 25);
    expect(r.bytes).toBe(ENTRY_CAP + 25);
    const page = archive({ path: "x.zip", size: 1, body: zip(files), media: "/m", download: "/d" });
    expect(String(page.content)).toContain("25 more entries are not listed");
  });
});

describe("archive page", () => {
  const draw = (path: string, body: Uint8Array) => archive({ path, size: body.length, body, media: "/m", download: "/d" });
  test("a name that is markup is escaped", () => {
    const out = String(draw("x.zip", zip([{ name: "<script>alert(1)</script>", size: 1 }])).content);
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
  test("a footer gives the count and unpacked size", () => {
    const out = String(draw("x.tar", tar([{ name: "a", size: 1000 }, { name: "b", size: 1000 }])).content);
    expect(out).toContain("2 entries");
    expect(out).toContain("unpacked");
  });
  test("a damaged archive falls back with a reason, never throws", () => {
    const r = draw("x.zip", enc("PK\x03\x04garbage"));
    expect(r.fallback).toMatch(/damaged/);
  });
  test("the extension names the kind and the bytes must agree", () => {
    const z = zip([{ name: "a" }]);
    expect(fileKind("a.zip", z)).toBe("archive");
    expect(fileKind("a.zip", enc("not a zip"))).toBe("text");
    expect(fileKind("a.tar.gz", gzipSync(enc("x")))).toBe("archive");
    expect(fileKind("a.tgz", gzipSync(enc("x")))).toBe("archive");
    expect(fileKind("a.gz", gzipSync(enc("x")))).toBe("binary");
    expect(fileKind("a.tar", tar([{ name: "a" }]))).toBe("archive");
  });
  test("a blob page reaches it, and not past the inline limit", () => {
    const z = zip([{ name: "a" }]);
    const hit = rendererFor("a.zip", { kind: "binary", body: z, size: z.length });
    expect(hit?.render).toBe(RENDERERS.archive!);
    expect(rendererFor("a.zip", { kind: "binary", body: z, size: 60_000_000 })).toBeUndefined();
  });
});

describe("wording and the terminal", () => {
  test("counts do not depend on the locale", async () => {
    const { count } = await import("../src/web/render/archive.ts");
    expect(count(0)).toBe("0");
    expect(count(2000)).toBe("2,000");
    expect(count(1234567)).toBe("1,234,567");
  });

  test("the over-50 MB sentence", async () => {
    const { overSize } = await import("../src/web/render/archive.ts");
    expect(overSize(50_000_000)).toBe("This archive is over 50 MB, too large to list here. Download it instead.");
  });

  test("a name with control and bidi characters is shown replaced", () => {
    const z = zip([{ name: "a‮b\u0007c.txt", size: 1 }]);
    const out = archive({ path: "x.zip", body: z, size: z.length } as never).content.toString();
    expect(out).not.toContain("‮");
    expect(out).not.toContain("\u0007");
    expect(out).toContain("a�b�c.txt");
  });

  test("the table is not inside a card", () => {
    const z = zip([{ name: "a.txt", size: 1 }]);
    const out = archive({ path: "x.zip", body: z, size: z.length } as never).content.toString();
    expect(out).not.toContain("card");
    expect(out).toContain('class="table archive-view"');
  });

  test("the terminal note gives count and unpacked size, gated like the page", async () => {
    const { archiveNote } = await import("../src/tui/ui/archive-note.ts");
    const fmt = (n: number): string => `${n} B`;
    const z = zip([{ name: "a.txt", size: 10 }, { name: "b/c.txt", size: 5 }]);
    expect(archiveNote("x.zip", z, z.length, fmt)).toBe("zip, 2 entries, 15 B unpacked.");
    expect(archiveNote("x.txt", z, z.length, fmt)).toBeUndefined();
    expect(archiveNote("x.zip", enc("not a zip at all"), 16, fmt)).toBeUndefined();
    expect(archiveNote("x.zip", z, 60_000_000, fmt)).toContain("over 50 MB");
    const bad = z.slice(0, z.length - 10);
    expect(archiveNote("x.zip", bad, bad.length, fmt)).toContain("damaged");
  });
});
