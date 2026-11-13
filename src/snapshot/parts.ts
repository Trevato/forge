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
 * Plain data in, plain data out: `pack` and `unpack` touch no store and no files; `unpacker` writes the one file it is given.
 */

import { createReadStream, createWriteStream, renameSync, rmSync, statSync } from "node:fs";
import { createZstdCompress, createZstdDecompress } from "node:zlib";

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

/**
 * A file on disk compressed and handed over part by part, never held whole:
 * the file is read as a stream through zstd and each full part goes to
 * `onPart` before the next is gathered, so memory is one part however big
 * the file. `pack` takes the whole body in one buffer, and a buffer cannot
 * pass 4 GiB: the forge's own database crossed that on 2026-11-13 and every
 * snapshot aborted the process. An empty file is one empty part, as in `pack`.
 */
export async function packFile(
  path: string,
  file: string,
  onPart: (n: number, part: Uint8Array) => Promise<void>,
  partBytes = PART_BYTES,
): Promise<PackedFile> {
  if (!safePath(path)) throw new Error(`refusing to pack ${path}`);
  if (!(partBytes > 0)) throw new Error(`a part of ${partBytes} bytes`);
  const bytes = statSync(file).size;
  const zst = createReadStream(file, { highWaterMark: 4 * 1_048_576 }).pipe(createZstdCompress());
  let held: Uint8Array[] = [];
  let heldBytes = 0;
  let parts = 0;
  let packedBytes = 0;
  const emit = async (size: number): Promise<void> => {
    const part = new Uint8Array(size);
    let at = 0;
    const rest: Uint8Array[] = [];
    for (const chunk of held) {
      const take = Math.min(chunk.byteLength, size - at);
      if (take > 0) part.set(chunk.subarray(0, take), at);
      at += take;
      if (take < chunk.byteLength) rest.push(chunk.subarray(take));
    }
    held = rest;
    heldBytes -= size;
    packedBytes += size;
    await onPart(parts++, part);
  };
  for await (const chunk of zst as AsyncIterable<Uint8Array>) {
    held.push(chunk);
    heldBytes += chunk.byteLength;
    while (heldBytes >= partBytes) await emit(partBytes);
  }
  if (heldBytes > 0 || parts === 0) await emit(heldBytes);
  return { path, bytes, packedBytes, parts };
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

export interface Unpacker {
  /** Hand over part `n`; resolves once part `n` itself is written, which waits for every part before it. */
  feed(n: number, body: Uint8Array): Promise<void>;
  /** Close the file, check its size, and put it at `target`; the bytes it unpacked to. */
  finish(): Promise<number>;
  /** Drop what was written, after a failure elsewhere. */
  abort(): void;
}

/**
 * A packed file unpacking as its parts arrive: each part, once every part
 * before it has come, goes into a zstd stream that writes the file out. No
 * whole compressed copy is held or written, only the parts waiting on an
 * earlier one; the file is written beside its target and renamed into place
 * when it checks out, so a refusal leaves nothing at `target`.
 */
export function unpacker(p: PackedFile, target: string): Unpacker {
  const partial = `${target}.partial`;
  const waiting = new Map<number, Uint8Array>();
  const waiters = new Map<number, { ok: () => void; no: (e: unknown) => void }>();
  const dec = createZstdDecompress();
  const out = createWriteStream(partial);
  let failure: unknown;
  // The first failure stands; every part still waiting for its turn hears of it.
  const fail = (e: unknown): void => {
    failure ??= e;
    for (const w of waiters.values()) w.no(failure);
    waiters.clear();
    waiting.clear();
    drop();
  };
  // Nothing of a refused file stays: the stream may still be opening, so the
  // file goes again once it has closed.
  const drop = (): void => {
    dec.destroy();
    out.destroy();
    out.once("close", () => rmSync(partial, { force: true }));
    rmSync(partial, { force: true });
  };
  dec.on("error", fail);
  out.on("error", fail);
  dec.pipe(out);
  let next = 0;
  let packedSoFar = 0;
  let chain: Promise<void> = Promise.resolve();
  const write = (body: Uint8Array): Promise<void> =>
    new Promise((resolve, reject) => {
      if (failure !== undefined) return reject(failure);
      dec.write(body, (e) => (e ? reject(e) : resolve()));
    });
  const drain = async (): Promise<void> => {
    for (let b = waiting.get(next); b !== undefined; b = waiting.get(next)) {
      const n = next++;
      waiting.delete(n);
      packedSoFar += b.byteLength;
      await write(b);
      waiters.get(n)?.ok();
      waiters.delete(n);
    }
  };
  const abort = (): void => {
    fail(new Error(`${p.path} was abandoned`));
  };
  return {
    feed(n, body) {
      if (!Number.isSafeInteger(n) || n < 0 || n >= p.parts)
        return Promise.reject(new Error(`${p.path} has no part ${n}`));
      if (n < next || waiting.has(n))
        return Promise.reject(new Error(`${p.path} part ${n} came twice`));
      if (failure !== undefined) return Promise.reject(failure);
      return new Promise<void>((ok, no) => {
        waiters.set(n, { ok, no });
        waiting.set(n, body);
        // The chain never rejects: a failure is `failure`, told to every waiter.
        chain = chain.then(drain).catch(fail);
      });
    },
    async finish() {
      try {
        await chain;
        if (failure !== undefined) throw failure;
        if (next !== p.parts)
          throw new Error(`${p.path} came back in ${next} parts, not ${p.parts}`);
        if (packedSoFar !== p.packedBytes)
          throw new Error(`${p.path}'s parts are ${packedSoFar} bytes, not ${p.packedBytes}`);
        await new Promise<void>((resolve, reject) => {
          out.on("finish", resolve);
          out.on("error", reject);
          dec.on("error", reject);
          dec.end();
        });
        if (out.bytesWritten !== p.bytes)
          throw new Error(`${p.path} unpacks to ${out.bytesWritten} bytes, not ${p.bytes}`);
        renameSync(partial, target);
        return out.bytesWritten;
      } catch (error) {
        abort();
        throw error;
      }
    },
    abort,
  };
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
