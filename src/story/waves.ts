/**
 * A repository's waves, read: `waves/*.md` on a branch, newest version first.
 * Parsing is `wave.ts`'s; a file that does not parse is listed with its
 * reason and breaks nothing. Both doors (the page and the terminal) read
 * through here; each applies its own visibility gate before calling.
 */

import { readerFor, listTree } from "../git/read.ts";
import { parseWave, VERSION as WAVE_VERSION, type Wave } from "./wave.ts";

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

/** One wave file by version, or null when the version is malformed or absent. */
export async function readWave(
  dir: string,
  branch: string,
  version: string,
): Promise<WaveEntry | null> {
  if (!WAVE_VERSION.test(version)) return null;
  const file = `${version}.md`;
  const path = `waves/${file}`;
  const tree = await listTree(dir, branch, "waves");
  if (!tree.ok) return null;
  const f = tree.value.find((e) => e.type === "blob" && e.name === file);
  if (!f) return null;
  if (f.size > MAX_BYTES) return { ok: false, file, reason: `${path}: file is too large` };
  const obj = await readerFor(dir).object(f.oid);
  if (!obj.ok) return { ok: false, file, reason: `${path}: unreadable` };
  const parsed = parseWave(path, new TextDecoder().decode(obj.value.body));
  return parsed.ok
    ? { ok: true, file, wave: parsed.value }
    : { ok: false, file, reason: parsed.error.message };
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

export interface PullRef {
  owner: string;
  name: string;
  number: number;
}

const PULL_PATH = /^\/([^/]+)\/([^/]+)\/pulls\/([1-9]\d{0,8})\/?$/;

/**
 * The pulls a wave names, as `owner/name#number`, in the file's order and
 * each once. A link that is not a pull's is not a reference and is left out.
 */
export function pullRefs(wave: Wave): PullRef[] {
  const seen = new Set<string>();
  const out: PullRef[] = [];
  for (const p of wave.pulls) {
    let path: string;
    try {
      path = new URL(p.url).pathname;
    } catch {
      continue;
    }
    const m = PULL_PATH.exec(path);
    if (!m) continue;
    let owner: string;
    let name: string;
    try {
      owner = decodeURIComponent(m[1]!);
      name = decodeURIComponent(m[2]!);
    } catch {
      continue;
    }
    const key = `${owner}/${name}#${m[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ owner, name, number: Number(m[3]) });
  }
  return out;
}

/**
 * How big a wave is for one viewer: the pulls they can see, once each, and the
 * distinct repositories (apps) those sit in. Takes the visible pulls (what
 * `carriedPulls` returns), never the whole wave, so a hidden pull is not counted.
 */
export function waveSize(refs: readonly { owner: string; name: string }[]): { pulls: number; apps: number } {
  return { pulls: refs.length, apps: new Set(refs.map((r) => `${r.owner}/${r.name}`)).size };
}

/** `7 changes in 3 apps`; `1 change in 1 app`. Numbers only, so nothing here needs escaping. */
export function sizeWords(size: { pulls: number; apps: number }): string {
  return `${size.pulls} ${size.pulls === 1 ? "change" : "changes"} in ${size.apps} ${size.apps === 1 ? "app" : "apps"}`;
}

/** A wave's one-line title, on the terminal's list: `<version> · <date> · <headline> · N changes in M apps`, counted over what this viewer can see. */
export function waveLine(w: Wave, size: { pulls: number; apps: number }): string {
  return `${w.version} · ${w.date} · ${w.headline} · ${sizeWords(size)}`;
}

/** Unreadable files tried before giving up on finding the newest good wave. */
const LATEST_TRIES = 5;

/**
 * The newest wave that parses, or null. Reads the tree once and only as many
 * files as it takes, so a home page can ask without paying for the archive.
 */
export async function latestWave(dir: string, branch: string): Promise<Wave | null> {
  const tree = await listTree(dir, branch, "waves");
  if (!tree.ok) return null;
  const files = tree.value
    .filter((e) => e.type === "blob" && e.name.endsWith(".md") && WAVE_VERSION.test(e.name.slice(0, -3)))
    .sort((x, y) => byVersionDesc(x.name.slice(0, -3), y.name.slice(0, -3)))
    .slice(0, LATEST_TRIES);
  const reader = readerFor(dir);
  for (const f of files) {
    if (f.size > MAX_BYTES) continue;
    const obj = await reader.object(f.oid);
    if (!obj.ok) continue;
    const parsed = parseWave(`waves/${f.name}`, new TextDecoder().decode(obj.value.body));
    if (parsed.ok) return parsed.value;
  }
  return null;
}

/** A wave's page on this forge. */
export const wavePath = (owner: string, name: string, version: string): string =>
  `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/waves/${encodeURIComponent(version)}`;

/** The query a pull link carries so the pull can lead back to the wave it was opened from. */
export const fromWave = (owner: string, name: string, version: string): string =>
  `?from=${encodeURIComponent(`${owner}/${name}@${version}`)}`;

const FROM = /^([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})@(.{1,64})$/;

/**
 * The wave a `?from=` names, as its page path, or null when the value is not
 * a well-formed wave address. Pure text: nothing is read, nothing echoed raw.
 */
export function backToWave(from: string | null): { href: string; version: string } | null {
  const m = from === null ? null : FROM.exec(from);
  if (!m || !WAVE_VERSION.test(m[3]!)) return null;
  return { href: wavePath(m[1]!, m[2]!, m[3]!), version: m[3]! };
}
