/**
 * A large file packed for a slow uplink: zstd over the whole of it, then
 * cut into parts of `PART_BYTES`, each its own object. Each part is one put
 * with its own deadline and its own retries, so a link that drops halfway
 * loses one part's progress, never the file's; and the mirror, which copies
 * object by object, moves parts the same way.
 *
 * The parts of `forge.db` are `forge.db.zst.0000`, `forge.db.zst.0001`, …;
 * the manifest lists them as files, like any other, and says once in
 * `packed` what they make together and how big that is. A restore reads
 * the parts back in order, joins them, and unpacks to exactly the bytes
 * that went in, or refuses.
 *
 * Plain data in, plain data out: no store, no files.
 */

/** A part's size: one put carries it within its own deadline at the floor rate (27 s at 5 Mbit/s). */
export const PART_BYTES = 16 * 1_048_576;

/** What the manifest says of a file that went up in parts. */
export interface PackedFile {
  /** The file's own path, as a restore writes it back. */
  readonly path: string;
  /** Its size as it was, before compression. */
  readonly bytes: number;
  /** Its size compressed: the parts' sizes added. */
  readonly packedBytes: number;
  readonly parts: number;
}

/** The key of part `n` of `path`, under a snapshot's prefix. */
export const partPath = (path: string, n: number): string =>
  `${path}.zst.${String(n).padStart(4, "0")}`;

/** Every part path of a packed file, in order. */
export const partPaths = (p: PackedFile): string[] =>
  Array.from({ length: p.parts }, (_, n) => partPath(p.path, n));

/** A path a restore may write under its data directory: relative, and never climbing out. */
export const safePath = (path: string): boolean =>
  path !== "" &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.split("/").some((s) => s === "" || s === "." || s === "..");

/**
 * `body` compressed and cut in parts. The parts are views of one buffer,
 * not copies; an empty body is one empty-content part, so every packed file
 * has at least one.
 */
export async function pack(
  path: string,
  body: Uint8Array,
  partBytes = PART_BYTES,
): Promise<{ packed: PackedFile; parts: Uint8Array[] }> {
  if (!safePath(path)) throw new Error(`refusing to pack ${path}`);
  if (!(partBytes > 0)) throw new Error(`a part of ${partBytes} bytes`);
  const zst = new Uint8Array(await Bun.zstdCompress(body));
  const parts: Uint8Array[] = [];
  for (let at = 0; at < zst.byteLength || parts.length === 0; at += partBytes)
    parts.push(zst.subarray(at, at + partBytes));
  return {
    packed: {
      path,
      bytes: body.byteLength,
      packedBytes: zst.byteLength,
      parts: parts.length,
    },
    parts,
  };
}

/** The file the parts make, checked against what the manifest says it was. */
export async function unpack(
  p: PackedFile,
  parts: readonly Uint8Array[],
): Promise<Uint8Array> {
  if (parts.length !== p.parts)
    throw new Error(`${p.path} came back in ${parts.length} parts, not ${p.parts}`);
  const total = parts.reduce((n, b) => n + b.byteLength, 0);
  if (total !== p.packedBytes)
    throw new Error(`${p.path}'s parts are ${total} bytes, not ${p.packedBytes}`);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const b of parts) {
    joined.set(b, at);
    at += b.byteLength;
  }
  const body = new Uint8Array(await Bun.zstdDecompress(joined));
  if (body.byteLength !== p.bytes)
    throw new Error(`${p.path} unpacks to ${body.byteLength} bytes, not ${p.bytes}`);
  return body;
}

/** Whether a manifest's `packed` entry reads whole: the restore trusts nothing else. */
export function isPackedFile(v: unknown): v is PackedFile {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  const count = (n: unknown): boolean => Number.isSafeInteger(n) && (n as number) >= 0;
  return (
    typeof p["path"] === "string" &&
    safePath(p["path"]) &&
    count(p["bytes"]) &&
    count(p["packedBytes"]) &&
    count(p["parts"]) &&
    (p["parts"] as number) >= 1
  );
}
