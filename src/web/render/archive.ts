/**
 * The entry list of a .zip, .tar or .tar.gz, and nothing else: names, sizes
 * and modified times read from the bytes of the archive itself. No entry is
 * unpacked, written or run; a gzip is inflated in memory under a hard cap,
 * only so its tar headers can be read.
 *
 * Formats: ZIP appnote 6.3.10 (end of central directory §4.3.16, central
 * directory header §4.3.12, zip64 §4.5.3); tar POSIX.1-2001 ustar, with the
 * pax `x` (§ extended header) and GNU `L` long-name records.
 */

import { gunzipSync } from "node:zlib";

/** Entries kept for display, whatever the archive holds. */
export const ENTRY_CAP = 2_000;
/** The most a gzip may inflate to before the list is given up. */
export const GUNZIP_CAP = 128 * 1024 * 1024;

export interface Entry {
  readonly path: string;
  /** Unpacked bytes. */
  readonly size: number;
  /** Modified time, or null when the archive gives none a person could read. */
  readonly mtime: Date | null;
  readonly dir: boolean;
}

export interface Listing {
  readonly format: "zip" | "tar" | "tar.gz";
  /** The first `ENTRY_CAP` entries, sorted by path. */
  readonly entries: readonly Entry[];
  /** Every entry the archive holds. */
  readonly count: number;
  /** Unpacked bytes of every entry, shown or not. */
  readonly bytes: number;
}

export interface Unreadable {
  readonly error: string;
}

class Corrupt extends Error {}
const corrupt = (): never => {
  throw new Corrupt();
};

const UTF8 = new TextDecoder("utf-8");

// ---- zip -----------------------------------------------------------------

const EOCD = 0x06054b50;
const EOCD64 = 0x06064b50;
const LOCATOR64 = 0x07064b50;
const CENTRAL = 0x02014b50;

/** MS-DOS date and time, read as UTC; null when the fields are not a date. */
function dosTime(date: number, time: number): Date | null {
  const year = ((date >> 9) & 127) + 1980;
  const month = (date >> 5) & 15;
  const day = date & 31;
  const hour = time >> 11;
  const minute = (time >> 5) & 63;
  const second = (time & 31) * 2;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59)
    return null;
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return d.getUTCDate() === day ? d : null;
}

function readZip(bytes: Uint8Array, keep: number): Omit<Listing, "format"> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) corrupt();
  let total = v.getUint16(eocd + 10, true);
  let offset = v.getUint32(eocd + 16, true);
  if (total === 0xffff || offset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || v.getUint32(loc, true) !== LOCATOR64) corrupt();
    const at = Number(v.getBigUint64(loc + 8, true));
    if (at < 0 || at + 56 > bytes.length || v.getUint32(at, true) !== EOCD64) corrupt();
    total = Number(v.getBigUint64(at + 32, true));
    offset = Number(v.getBigUint64(at + 48, true));
  }
  if (offset > eocd) corrupt();
  const kept: Entry[] = [];
  let count = 0;
  let sum = 0;
  let p = offset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== CENTRAL) corrupt();
    const flags = v.getUint16(p + 8, true);
    if (flags & 1) throw new Corrupt("encrypted");
    let size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > bytes.length) corrupt();
    if (size === 0xffffffff) {
      // zip64 extra field (id 1): the unpacked size comes first.
      let e = p + 46 + nameLen;
      const stop = e + extraLen;
      while (e + 4 <= stop) {
        const id = v.getUint16(e, true);
        const len = v.getUint16(e + 2, true);
        if (id === 1 && len >= 8 && e + 12 <= stop) {
          size = Number(v.getBigUint64(e + 4, true));
          break;
        }
        e += 4 + len;
      }
      if (size === 0xffffffff) corrupt();
    }
    count++;
    sum += size;
    if (kept.length < keep) {
      const path = UTF8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      kept.push({
        path,
        size,
        mtime: dosTime(v.getUint16(p + 14, true), v.getUint16(p + 12, true)),
        dir: path.endsWith("/"),
      });
    }
    p = end;
  }
  return { entries: kept, count, bytes: sum };
}

// ---- tar -----------------------------------------------------------------

const BLOCK = 512;

const cstr = (b: Uint8Array, from: number, len: number): string => {
  let end = from;
  while (end < from + len && b[end] !== 0) end++;
  return UTF8.decode(b.subarray(from, end));
};

/** An octal field, or GNU base-256 when its top bit is set. */
function number(b: Uint8Array, from: number, len: number): number {
  if (b[from]! & 0x80) {
    let n = b[from]! & 0x7f;
    for (let i = 1; i < len; i++) n = n * 256 + b[from + i]!;
    return n;
  }
  const text = cstr(b, from, len).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) return corrupt();
  return parseInt(text, 8);
}

/** The header checksum: every byte summed, the checksum field as spaces. */
function checksumOk(b: Uint8Array, at: number): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : b[at + i]!;
  return sum === number(b, at + 148, 8);
}

/** pax records: `len key=value\n`, the length counting itself. */
function pax(data: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let p = 0;
  while (p < data.length) {
    let q = p;
    while (q < data.length && data[q] !== 0x20) q++;
    const len = parseInt(UTF8.decode(data.subarray(p, q)), 10);
    if (!(len > q - p + 1) || p + len > data.length) corrupt();
    const rec = UTF8.decode(data.subarray(q + 1, p + len - 1));
    const eq = rec.indexOf("=");
    if (eq > 0) out.set(rec.slice(0, eq), rec.slice(eq + 1));
    p += len;
  }
  return out;
}

function readTar(b: Uint8Array, keep: number): Omit<Listing, "format"> {
  const kept: Entry[] = [];
  let count = 0;
  let sum = 0;
  let p = 0;
  let longName: string | undefined;
  let override = new Map<string, string>();
  while (p + BLOCK <= b.length) {
    if (b.subarray(p, p + BLOCK).every((x) => x === 0)) break;
    if (!checksumOk(b, p)) corrupt();
    const type = String.fromCharCode(b[p + 156]!);
    let size = number(b, p + 124, 12);
    const data = p + BLOCK;
    if (data + size > b.length) corrupt();
    const next = data + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      override = pax(b.subarray(data, data + size));
    } else if (type === "L") {
      longName = cstr(b, data, size);
    } else if (type !== "g") {
      const ustar = cstr(b, p + 257, 5) === "ustar";
      const prefix = ustar ? cstr(b, p + 345, 155) : "";
      const base = cstr(b, p, 100);
      let path = longName ?? override.get("path") ?? (prefix ? `${prefix}/${base}` : base);
      const sizeOverride = override.get("size");
      if (sizeOverride !== undefined && /^\d+$/.test(sizeOverride)) size = Number(sizeOverride);
      const mt = override.get("mtime");
      const secs = mt !== undefined && /^\d+(\.\d+)?$/.test(mt) ? Number(mt) : number(b, p + 136, 12);
      const dir = type === "5" || path.endsWith("/");
      if (dir && !path.endsWith("/")) path += "/";
      const shown = type === "0" || type === "\0" || type === "7" ? size : 0;
      count++;
      sum += shown;
      if (kept.length < keep) {
        const t = new Date(secs * 1000);
        kept.push({ path, size: shown, mtime: secs > 0 && !Number.isNaN(t.getTime()) ? t : null, dir });
      }
      longName = undefined;
      override = new Map();
    }
    p = next;
  }
  if (count === 0) corrupt();
  return { entries: kept, count, bytes: sum };
}

// ---- entry point -----------------------------------------------------------

const isZip = (b: Uint8Array): boolean => b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4;
const isGzip = (b: Uint8Array): boolean => b[0] === 0x1f && b[1] === 0x8b;

const byPath = (a: Entry, b: Entry): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** A count with thousands grouped by commas, whatever the server locale. */
export const count = (n: number): string => String(n).replace(/\B(?=(\d{3})+$)/g, ",");

const mb = (n: number): string => `${count(Math.round(n / 1_000_000))} MB`;

/** The sentence for an archive over the size the page reads. */
export const overSize = (cap: number): string =>
  `This archive is over ${count(Math.round(cap / 1_000_000))} MB, too large to list here. Download it instead.`;

/** The list of what an archive holds, or one sentence on why it cannot be. */
export function listArchive(
  body: Uint8Array,
  opts: { readonly cap?: number; readonly entries?: number } = {},
): Listing | Unreadable {
  const cap = opts.cap ?? GUNZIP_CAP;
  const keep = opts.entries ?? ENTRY_CAP;
  try {
    let format: Listing["format"];
    let part: Omit<Listing, "format">;
    if (isZip(body)) {
      format = "zip";
      part = readZip(body, keep);
    } else if (isGzip(body)) {
      format = "tar.gz";
      let tar: Uint8Array;
      try {
        tar = gunzipSync(body, { maxOutputLength: cap });
      } catch (e) {
        if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE")
          return { error: `This archive unpacks to more than ${mb(cap)}, so its list is not read here.` };
        return { error: "This archive is damaged, so its list cannot be read." };
      }
      part = readTar(tar, keep);
    } else {
      format = "tar";
      part = readTar(body, keep);
    }
    return { format, ...part, entries: [...part.entries].sort(byPath) };
  } catch (e) {
    if (e instanceof Corrupt && e.message === "encrypted")
      return { error: "This zip is encrypted, so its list is not shown." };
    if (e instanceof Corrupt || e instanceof RangeError)
      return { error: "This archive is damaged or cut short, so its list cannot be read." };
    throw e;
  }
}
