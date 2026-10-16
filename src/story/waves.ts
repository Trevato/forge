/**
 * A repository's waves, read: `waves/*.md` on a branch, newest version first.
 * Parsing is `wave.ts`'s; a file that does not parse is listed with its
 * reason and breaks nothing. Both doors (the page and the terminal) read
 * through here; each applies its own visibility gate before calling.
 */

import { readerFor, listTree } from "../git/read.ts";
import { parseWave, type Wave } from "./wave.ts";

/** A page, not an archive: more files than this are not read. */
const MAX_FILES = 300;
/** A wave is a few hundred lines; a larger file is not one. */
const MAX_BYTES = 256 * 1024;

export type WaveEntry =
  | { ok: true; file: string; wave: Wave }
  | { ok: false; file: string; reason: string };

const VERSION = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/;

type Version = { core: number[]; pre: string[] };

const parse = (s: string): Version | null => {
  const m = VERSION.exec(s);
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)],
    pre: m[4] === undefined ? [] : m[4].split("."),
  };
};

const DIGITS = /^\d+$/;

/** Semver §11 for one pre-release identifier: numbers by value, below text. */
function identifier(a: string, b: string): number {
  const an = DIGITS.test(a);
  const bn = DIGITS.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an !== bn) return an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Higher version first; a release beats its own pre-release, pre-release
 * identifiers compare dot by dot. A name that is not a version sorts after
 * every version, and those among themselves by name, so the order is total.
 */
export function byVersionDesc(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return x ? -1 : y ? 1 : a < b ? -1 : a > b ? 1 : 0;
  for (let i = 0; i < 3; i++) {
    const d = y.core[i]! - x.core[i]!;
    if (d !== 0) return d;
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length ? 1 : y.pre.length ? -1 : 0;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const d = identifier(y.pre[i]!, x.pre[i]!);
    if (d !== 0) return d;
  }
  return y.pre.length - x.pre.length;
}

/** Every wave file on `branch`, parsed; good ones newest first, then the bad. */
export async function readWaves(
  dir: string,
  branch: string,
): Promise<WaveEntry[]> {
  const tree = await listTree(dir, branch, "waves");
  if (!tree.ok) return [];
  const files = tree.value
    .filter((e) => e.type === "blob" && e.name.endsWith(".md"))
    // Git orders names as strings (`0.10.0` before `0.9.0`); the cut is made
    // on version order so the newest waves are the ones kept.
    .sort((x, y) => byVersionDesc(x.name.slice(0, -3), y.name.slice(0, -3)))
    .slice(0, MAX_FILES);
  const reader = readerFor(dir);
  const out: WaveEntry[] = [];
  for (const f of files) {
    const path = `waves/${f.name}`;
    if (f.size > MAX_BYTES) {
      out.push({ ok: false, file: f.name, reason: `${path}: file is too large` });
      continue;
    }
    const obj = await reader.object(f.oid);
    if (!obj.ok) {
      out.push({ ok: false, file: f.name, reason: `${path}: unreadable` });
      continue;
    }
    const text = new TextDecoder().decode(obj.value.body);
    const parsed = parseWave(path, text);
    out.push(
      parsed.ok
        ? { ok: true, file: f.name, wave: parsed.value }
        : { ok: false, file: f.name, reason: parsed.error.message },
    );
  }
  const good = out.flatMap((e) => (e.ok ? [e] : []));
  const bad = out.flatMap((e) => (e.ok ? [] : [e]));
  good.sort((a, b) => byVersionDesc(a.wave.version, b.wave.version));
  return [...good, ...bad];
}

