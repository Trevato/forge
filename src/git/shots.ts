/**
 * A pin's screenshots: curated pictures that ride with a build, for a
 * feature too costly to stand up as a running preview. They live in git
 * as one tree kept by `refs/shots/<label>`, beside `refs/covers/<label>`:
 * the pictures, named `01.png`, `02.jpg`, … in the order shown, and a
 * `shots.json` that lists them with their captions. Every change writes a
 * new tree and moves the ref from the one it read, so two edits never
 * cross. Nothing lives in the database.
 *
 * The ref can be pushed like any other, so what it holds is read as
 * untrusted: a file the list names must be a picture by its first bytes,
 * named as this module names them, and no larger than a person may upload.
 */

import { err, ok, type Result } from "../kernel/result.ts";
import { coverType, isPinLabel } from "./builds.ts";
import { runGit, runGitCapture, runGitRaw } from "./env.ts";
import { isSafeOid } from "./guard.ts";

export const SHOTS_PREFIX = "refs/shots/";

/** The largest screenshot a person may add. */
export const SHOT_MAX = 2 * 1024 * 1024;
/** How many screenshots one pin may carry. */
export const SHOTS_LIMIT = 12;
/** The longest caption. */
export const CAPTION_MAX = 140;
/** The list's own name in the tree. */
const LIST = "shots.json";

export type ShotType = "image/png" | "image/jpeg" | "image/webp";
const EXT: Record<ShotType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const TYPE_OF: Record<string, ShotType> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

/** One screenshot as the tree holds it. */
export interface Shot {
  /** Its name in the tree: its place in the order and its kind. */
  readonly file: string;
  /** One plain line; may be empty. */
  readonly caption: string;
  /** The blob it is. */
  readonly oid: string;
  readonly type: ShotType;
  readonly size: number;
}

/** A pin's screenshots and the tree they were read from. */
export interface Shots {
  /** The tree the ref points at, or undefined when the pin has none. */
  readonly tree: string | undefined;
  readonly items: readonly Shot[];
}

/** What a write keeps: a stored picture and its caption, in order. */
export type ShotEntry = Omit<Shot, "file">;

/** A name this module gives a screenshot. */
export const isShotFile = (file: string): boolean => /^\d{2}\.(?:png|jpg|webp)$/.test(file);

/** A caption: one plain line, at most `CAPTION_MAX` characters, maybe empty. */
export const isCaption = (caption: string): boolean =>
  caption.length <= CAPTION_MAX && !/[\x00-\x1f\x7f]/.test(caption) && caption.trim() === caption;

/** A caption as a person typed it: line breaks folded, ends trimmed. */
export const cleanCaption = (caption: string): string => caption.replace(/[\r\n\t]+/g, " ").trim();

/** The ref of one pin's screenshots. */
const refOf = (label: string): string => `${SHOTS_PREFIX}${label}`;

/** A pin's screenshots, read from its tree; none when it has no tree. */
export async function readShots(dir: string, label: string): Promise<Shots> {
  const none: Shots = { tree: undefined, items: [] };
  if (!isPinLabel(label)) return none;
  const at = await runGitCapture(["rev-parse", "--verify", "--quiet", refOf(label)], { cwd: dir });
  const tree = at.stdout.trim();
  if (at.code !== 0 || !isSafeOid(tree)) return none;
  const kind = await runGitCapture(["cat-file", "-t", tree], { cwd: dir });
  if (kind.code !== 0 || kind.stdout.trim() !== "tree") return none;
  const listed = await runGit(["ls-tree", "-l", "-z", tree], { cwd: dir });
  if (!listed.ok) return { tree, items: [] };
  // `<mode> <type> <oid> <size>\t<name>`, one per NUL.
  const blobs = new Map<string, { oid: string; size: number }>();
  for (const line of listed.value.split("\0")) {
    const m = /^100644 blob ([0-9a-f]{40,64}) +(\d+)\t(.+)$/.exec(line);
    if (m !== null) blobs.set(m[3]!, { oid: m[1]!, size: Number(m[2]) });
  }
  const list = blobs.get(LIST);
  if (list === undefined || list.size > 64 * 1024) return { tree, items: [] };
  const text = await runGit(["cat-file", "blob", list.oid], { cwd: dir });
  if (!text.ok) return { tree, items: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text.value);
  } catch {
    return { tree, items: [] };
  }
  if (!Array.isArray(raw)) return { tree, items: [] };
  const items: Shot[] = [];
  const seen = new Set<string>();
  for (const entry of raw as unknown[]) {
    if (items.length >= SHOTS_LIMIT) break;
    if (typeof entry !== "object" || entry === null) continue;
    const { file, caption } = entry as { file?: unknown; caption?: unknown };
    if (typeof file !== "string" || !isShotFile(file) || seen.has(file)) continue;
    const blob = blobs.get(file);
    if (blob === undefined || blob.size > SHOT_MAX) continue;
    seen.add(file);
    items.push({
      file,
      caption: typeof caption === "string" && isCaption(caption) ? caption : "",
      oid: blob.oid,
      type: TYPE_OF[file.slice(3)]!,
      size: blob.size,
    });
  }
  return { tree, items };
}

/** One screenshot's bytes and kind, by its first bytes; undefined when it is not a picture. */
export async function readShotBytes(
  dir: string,
  label: string,
  file: string,
): Promise<{ readonly bytes: Uint8Array; readonly type: ShotType; readonly oid: string } | undefined> {
  if (!isShotFile(file)) return undefined;
  const shot = (await readShots(dir, label)).items.find((s) => s.file === file);
  if (shot === undefined) return undefined;
  const bytes = await runGitRaw(["cat-file", "blob", shot.oid], { cwd: dir });
  if (!bytes.ok) return undefined;
  const type = coverType(bytes.value);
  return type === undefined ? undefined : { bytes: bytes.value, type, oid: shot.oid };
}

/** Store a picture as a blob: refused unless it is a PNG, JPEG or WebP by its first bytes, within `SHOT_MAX`. */
export async function storeShot(dir: string, bytes: Uint8Array): Promise<Result<{ oid: string; type: ShotType; size: number }, "invalid_shot" | "too_large" | "git_failed">> {
  const type = coverType(bytes);
  if (type === undefined) return err("invalid_shot");
  if (bytes.length > SHOT_MAX) return err("too_large");
  const blob = await runGit(["hash-object", "-w", "--stdin"], { cwd: dir, stdin: bytes });
  if (!blob.ok) return err("git_failed");
  return ok({ oid: blob.value.trim(), type, size: bytes.length });
}

export type WriteShotsError = "too_many" | "invalid_caption" | "moved" | "git_failed";

/**
 * Keep `entries`, in order, as the pin's screenshots: a new tree, and the
 * ref moved to it only from `from` (undefined: only when there is none).
 * No entries removes the ref.
 */
export async function writeShots(
  dir: string,
  label: string,
  from: string | undefined,
  entries: readonly ShotEntry[],
): Promise<Result<Shots, WriteShotsError>> {
  if (!isPinLabel(label)) return err("git_failed");
  if (entries.length > SHOTS_LIMIT) return err("too_many");
  if (entries.some((e) => !isCaption(e.caption) || !isSafeOid(e.oid))) return err("invalid_caption");
  if (from !== undefined && !isSafeOid(from)) return err("moved");
  if (entries.length === 0) {
    if (from === undefined) return ok({ tree: undefined, items: [] });
    const gone = await runGitCapture(["update-ref", "-d", refOf(label), from], { cwd: dir });
    return gone.code === 0 ? ok({ tree: undefined, items: [] }) : err("moved");
  }
  const named = entries.map((e, i) => ({ ...e, file: `${String(i + 1).padStart(2, "0")}.${EXT[e.type]}` }));
  const list = `${JSON.stringify(named.map((e) => ({ file: e.file, caption: e.caption })), null, 2)}\n`;
  const listBlob = await runGit(["hash-object", "-w", "--stdin"], { cwd: dir, stdin: list });
  if (!listBlob.ok) return err("git_failed");
  const lines = [
    ...named.map((e) => `100644 blob ${e.oid}\t${e.file}\n`),
    `100644 blob ${listBlob.value.trim()}\t${LIST}\n`,
  ];
  const made = await runGit(["mktree"], { cwd: dir, stdin: lines.join("") });
  if (!made.ok) return err("git_failed");
  const tree = made.value.trim();
  const moved = await runGitCapture(["update-ref", refOf(label), tree, from ?? ""], { cwd: dir });
  if (moved.code !== 0) return err("moved");
  return ok({ tree, items: named });
}
