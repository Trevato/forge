/** Hand-built ISO-BMFF boxes for tests: big-endian, sizes counted by hand. */
export function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const len = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  new DataView(out.buffer).setUint32(0, len);
  out.set(new TextEncoder().encode(type), 4);
  let at = 8;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}

export function u32(...ns: number[]): Uint8Array {
  const out = new Uint8Array(ns.length * 4);
  ns.forEach((n, i) => new DataView(out.buffer).setUint32(i * 4, n));
  return out;
}

export function u64(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n);
  return out;
}

/** mvhd v0: version/flags, creation, modification, timescale, duration, then 80 bytes of rest. */
export const mvhd0 = (timescale: number, duration: number) =>
  box("mvhd", u32(0, 0, 0, timescale, duration), new Uint8Array(80));

/** mvhd v1: 64-bit creation, modification and duration. */
export const mvhd1 = (timescale: number, duration: bigint) =>
  box("mvhd", u32(0x01000000), u64(0n), u64(0n), u32(timescale), u64(duration), new Uint8Array(80));

/** tkhd: v0 has 20 bytes of times/ids, v1 32; then 52 of reserved/layer/volume/matrix; then 16.16 width and height. */
export const tkhd = (version: 0 | 1, width: number, height: number, matrix = IDENTITY) =>
  box(
    "tkhd",
    u32(version << 24),
    new Uint8Array(version === 1 ? 32 : 20),
    new Uint8Array(16),
    u32(...matrix.map((n) => n >>> 0)),
    u32(width * 65536, height * 65536),
  );

/** The tkhd matrix {a b u c d v x y w}: a, b, c, d, x, y in 16.16, u, v, w in 2.30. */
export const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
export const ROTATE_90 = [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000];

/** mvex → mehd fragment_duration, v0 32-bit or v1 64-bit. */
export const mvex = (version: 0 | 1, duration: number) =>
  box("mvex", box("mehd", u32(version << 24), version === 1 ? u64(BigInt(duration)) : u32(duration)));

export const ftyp = () => box("ftyp", new TextEncoder().encode("isom"), u32(0x200));

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}
