/**
 * Address ranges: `10.42.0.0/16`, `fd00::/8`, or one address. Small and
 * strict — a malformed entry is an error, never skipped, because a range an
 * operator meant to trust and the forge silently dropped is a range that is
 * not where they think it is.
 */

import { err, ok, type Result } from "./result.ts";

export interface Cidr {
  readonly bytes: Uint8Array;
  readonly bits: number;
}

function ipv4(text: string): Uint8Array | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const out = new Uint8Array(4);
  for (const [i, part] of parts.entries()) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    out[i] = n;
  }
  return out;
}

function ipv6(text: string): Uint8Array | undefined {
  if (!/^[0-9a-f:.]+$/i.test(text) || !text.includes(":")) return undefined;
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const words = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    const pieces = part.split(":");
    for (const [i, piece] of pieces.entries()) {
      // A trailing dotted quad (`::ffff:1.2.3.4`) is two words.
      if (i === pieces.length - 1 && piece.includes(".")) {
        const v4 = ipv4(piece);
        if (v4 === undefined) return undefined;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(piece)) return undefined;
        out.push(parseInt(piece, 16));
      }
    }
    return out;
  };
  const head = words(halves[0]!);
  const tail = halves.length === 2 ? words(halves[1]!) : [];
  if (head === undefined || tail === undefined) return undefined;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return undefined;
  const all = [...head, ...new Array<number>(fill).fill(0), ...tail];
  const out = new Uint8Array(16);
  for (const [i, w] of all.entries()) {
    out[i * 2] = w >> 8;
    out[i * 2 + 1] = w & 0xff;
  }
  return out;
}

/**
 * An address as bytes: 4 for IPv4, 16 for IPv6. An IPv4-mapped IPv6 address
 * (`::ffff:10.0.0.1`, how a dual-stack socket reports an IPv4 peer) is its
 * IPv4 address, so one range matches both spellings.
 */
export function addressBytes(text: string): Uint8Array | undefined {
  const v4 = ipv4(text);
  if (v4 !== undefined) return v4;
  const v6 = ipv6(text.replace(/^\[|\]$/g, ""));
  if (v6 === undefined) return undefined;
  const mapped =
    v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff;
  return mapped ? v6.slice(12) : v6;
}

/** One range, or one address as a range of its own length. */
export function parseCidr(text: string): Cidr | undefined {
  const [addr, len, extra] = text.trim().split("/");
  if (addr === undefined || extra !== undefined) return undefined;
  const bytes = addressBytes(addr);
  if (bytes === undefined) return undefined;
  const max = bytes.length * 8;
  if (len === undefined) return { bytes, bits: max };
  if (!/^\d{1,3}$/.test(len)) return undefined;
  const bits = Number(len);
  return bits <= max ? { bytes, bits } : undefined;
}

/** A comma-separated list; an empty string is an empty list. */
export function parseCidrs(text: string): Result<Cidr[], string> {
  const out: Cidr[] = [];
  for (const entry of text.split(",").map((s) => s.trim())) {
    if (entry === "") continue;
    const cidr = parseCidr(entry);
    if (cidr === undefined) return err(entry);
    out.push(cidr);
  }
  return ok(out);
}

export function inCidr(address: string, cidr: Cidr): boolean {
  const bytes = addressBytes(address);
  if (bytes === undefined || bytes.length !== cidr.bytes.length) return false;
  const whole = Math.floor(cidr.bits / 8);
  for (let i = 0; i < whole; i++) if (bytes[i] !== cidr.bytes[i]) return false;
  const rest = cidr.bits % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (bytes[whole]! & mask) === (cidr.bytes[whole]! & mask);
}

export const inCidrs = (address: string, list: readonly Cidr[]): boolean =>
  list.some((c) => inCidr(address, c));
