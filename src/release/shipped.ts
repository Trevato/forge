/**
 * The releases this forge has shipped, newest first: the ones cut before
 * #6642 from `core/releases-before-tags.json`, frozen, and every one since
 * from its annotated tag `v<version>` in the forge's own repository, whose
 * message is the record `{ "version", "migrations", "ids" }`
 * (`scripts/cut-release.ts` writes it). Cutting a release moves no branch,
 * so it never voids a gate in flight or stales a pull's check (#6640).
 *
 * The tags are read from the git store, never the network, by the same
 * ten-minute tick that watches for production behind (`release/behind.ts`,
 * through `release/own_tags.ts`, which finds the repository and logs why not);
 * what was read is kept in memory, so `/releases.json` and the children's
 * standings read a list, not git. A forge with no repository of its own
 * (`FORGE_REPO` unset, a test) ships the frozen list alone.
 */

import before from "../core/releases-before-tags.json" with { type: "json" };
import { runGit } from "../git/env.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export interface Shipped {
  readonly version: string;
  /** How many migration ids the release applied. */
  readonly migrations: number;
  /** The stamped ones among them, by name; absent on a release from before #1837. */
  readonly ids?: readonly string[];
  /** When the tag was cut (epoch ms); absent on a frozen release. */
  readonly at?: number;
}

const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/;
/** More tags than this are older than anything a reader asks about. */
const MAX_TAGS = 1000;
const MAX_IDS = 10_000;

/** A tag message as a release record, or undefined when it is not one. */
export function parseRecord(message: string): Omit<Shipped, "at"> | undefined {
  // A signed tag carries its signature after the message.
  const text = message.split(/\n-----BEGIN [A-Z ]*SIGNATURE-----/)[0]!.trim();
  if (!text.startsWith("{")) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof doc !== "object" || doc === null) return undefined;
  const { version, migrations, ids } = doc as Record<string, unknown>;
  if (typeof version !== "string" || !VERSION.test(version)) return undefined;
  if (!Number.isSafeInteger(migrations) || (migrations as number) < 0) return undefined;
  if (ids === undefined) return { version, migrations: migrations as number };
  if (!Array.isArray(ids) || ids.length > MAX_IDS || !ids.every((i) => typeof i === "string" && ID.test(i)))
    return undefined;
  return { version, migrations: migrations as number, ids: ids as string[] };
}

/** Newer first: dotted numbers compare as numbers, anything else as text. */
export function compareVersions(a: string, b: string): number {
  const x = a.split("."), y = b.split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? "", q = y[i] ?? "";
    if (p === q) continue;
    const m = Number(p), n = Number(q);
    if (p !== "" && q !== "" && Number.isInteger(m) && Number.isInteger(n)) return n - m;
    return p < q ? 1 : -1;
  }
  return 0;
}

/** The frozen releases and the tagged ones as one list, newest first; a tag wins over a frozen entry of its version. */
export function mergeShipped(frozen: readonly Shipped[], tagged: readonly Shipped[]): Shipped[] {
  const byVersion = new Map<string, Shipped>();
  for (const r of frozen) byVersion.set(r.version, r);
  for (const r of tagged) byVersion.set(r.version, r);
  return [...byVersion.values()].sort((a, b) => compareVersions(a.version, b.version));
}

/** The release records on the annotated `v*` tags of the repository at `dir`, newest first; why not when git cannot say. */
export async function readTags(dir: string): Promise<Result<Shipped[], string>> {
  const args = [
    "for-each-ref",
    `--count=${MAX_TAGS}`,
    "--sort=-creatordate",
    "--format=%(objecttype)%00%(creatordate:unix)%00%(contents)%01",
    "refs/tags/v*",
  ];
  // A repository not yet on disk cannot even be a working directory.
  const out = await runGit(args, { cwd: dir }).catch((e: unknown) => err(String(e)));
  if (!out.ok) return err(typeof out.error === "string" ? out.error : out.error.stderr || `git exited ${out.error.code}`);
  const records: Shipped[] = [];
  for (const entry of out.value.split("\x01")) {
    const [type, secs, message] = entry.replace(/^\n/, "").split("\x00");
    if (type !== "tag" || message === undefined) continue;
    const record = parseRecord(message);
    const at = Number(secs) * 1000;
    if (record !== undefined && Number.isFinite(at) && at > 0) records.push({ ...record, at });
  }
  return ok(mergeShipped([], records));
}

/** The release records of the repository at `dir`, newest first; [] when git cannot say. */
export async function readTagged(dir: string): Promise<Shipped[]> {
  const read = await readTags(dir);
  return read.ok ? read.value : [];
}

const frozen: readonly Shipped[] = before.releases;
let current: readonly Shipped[] = frozen;

/** Every release this forge has shipped, newest first. The same array until the tags read differently. */
export function shippedReleases(): readonly Shipped[] {
  return current;
}

/** Keep what the tags said; main calls this from its tick. */
export function setTagged(tagged: readonly Shipped[]): void {
  current = tagged.length === 0 ? frozen : mergeShipped(frozen, tagged);
}

/** The record a release cut from these migration files carries: every one counted, the stamped ones named. */
export function recordFor(
  version: string,
  files: readonly { readonly name: string }[],
  numbered: number,
): Omit<Shipped, "at"> {
  return { version, migrations: files.length, ids: files.slice(numbered).map((m) => m.name) };
}
