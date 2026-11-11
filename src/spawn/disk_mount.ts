/**
 * Whether a child forge's writable space, `<data>/children/<id>`, is a
 * filesystem of its own: a mount whose mount point is exactly that
 * directory, read from `/proc/self/mountinfo` (proc(5)). On one, writing
 * past its size is ENOSPC inside the child and the parent's free space does
 * not move; on the shared disk only the cell's disk watch stops it, after
 * the fact (#10851). This module reads what is mounted; it mounts nothing.
 *
 * Plain data in, plain data out: the mountinfo is passed in as text and the
 * size read through `stat`, so a test feeds both.
 */

import { readFileSync, realpathSync, statfsSync } from "node:fs";
import { join } from "node:path";

/** One line of mountinfo, the fields this module reads. */
export interface Mount {
  /** Field 5: where it is mounted, its octal escapes (`\040` is a space) undone. */
  readonly mountPoint: string;
  /** The first field after ` - `: ext4, xfs, overlay, tmpfs… */
  readonly fsType: string;
}

/** A child's writable space as the forge finds it. */
export type ChildDisk =
  | { readonly own: true; readonly path: string; readonly fsType: string; readonly bytes: number; readonly inodes: number }
  | { readonly own: false; readonly path: string };

/** What `statfs(2)` says of a filesystem, the fields read here. */
export interface FsSize {
  /** Block size in bytes (`f_bsize`). */
  readonly bsize: number;
  /** Total blocks (`f_blocks`). */
  readonly blocks: number;
  /** Total inodes (`f_files`). */
  readonly files: number;
}

/** A body id is one path segment: letters, digits, `.`, `_`, `-`; a first character other than `.` rules out `.` and `..`. */
const BODY_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
export const validBodyId = (id: string): boolean => BODY_ID.test(id);

/** Undo mountinfo's octal escapes: space, tab, newline and backslash are written `\ooo`. */
const unescape = (field: string): string => field.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));

/**
 * Every mount in a mountinfo text. A line reads
 * `36 35 98:0 /mnt1 /mnt/parent rw,noatime master:1 - ext3 /dev/root rw`:
 * mount point fifth, then optional fields up to a lone `-`, then the type. A line that does not have that shape is skipped.
 */
export function parseMountinfo(text: string): Mount[] {
  const mounts: Mount[] = [];
  for (const line of text.split("\n")) {
    const fields = line.split(" ");
    const dash = fields.indexOf("-", 6);
    if (fields.length < 7 || dash < 0) continue;
    const mountPoint = fields[4];
    const fsType = fields[dash + 1];
    if (mountPoint === undefined || fsType === undefined || !mountPoint.startsWith("/")) continue;
    mounts.push({ mountPoint: unescape(mountPoint), fsType });
  }
  return mounts;
}

/** The mount whose mount point is exactly `path` (the last one, as the kernel stacks them); undefined when none. */
export function mountAt(mounts: readonly Mount[], path: string): Mount | undefined {
  const want = path.length > 1 ? path.replace(/\/+$/, "") : path;
  let found: Mount | undefined;
  for (const m of mounts) if (m.mountPoint === want) found = m;
  return found;
}

/**
 * The child's writable space: its own filesystem with its size in bytes
 * (blocks × block size) and inodes, or the shared disk. `path` is where the
 * mount must sit, already resolved (`childDiskPath`). A filesystem whose size
 * cannot be read is not counted as the child's own.
 */
export function childDisk(input: { path: string; mountinfo: string; size: (path: string) => FsSize | undefined }): ChildDisk {
  const mount = mountAt(parseMountinfo(input.mountinfo), input.path);
  if (mount === undefined) return { own: false, path: input.path };
  const fs = input.size(input.path);
  if (fs === undefined || !(fs.bsize > 0) || !(fs.blocks > 0)) return { own: false, path: input.path };
  return { own: true, path: input.path, fsType: mount.fsType, bytes: fs.blocks * fs.bsize, inodes: fs.files };
}

/** `<data>/children/<id>`, symlinks resolved (mountinfo names real paths); the joined path when it does not exist yet. */
export function childDiskPath(dataDir: string, bodyId: string): string | undefined {
  if (!validBodyId(bodyId)) return undefined;
  const path = join(dataDir, "children", bodyId);
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** This process's mountinfo; "" where there is none (not Linux), which reads as no mount at all. */
export function readMountinfo(): string {
  try {
    return readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return "";
  }
}

/** `statfs` of `path`; undefined when it cannot be read. */
export function statSize(path: string): FsSize | undefined {
  try {
    const s = statfsSync(path);
    return { bsize: Number(s.bsize), blocks: Number(s.blocks), files: Number(s.files) };
  } catch {
    return undefined;
  }
}

/** The live answer for one child: this process's mounts, the real `statfs`. */
export function liveChildDisk(dataDir: string, bodyId: string, mountinfo: string = readMountinfo()): ChildDisk {
  const path = childDiskPath(dataDir, bodyId);
  return path === undefined ? { own: false, path: join(dataDir, "children") } : childDisk({ path, mountinfo, size: statSize });
}

const GIB = 1024 ** 3;

/** GiB to one place, the `.0` dropped: 10 GiB is 10 737 418 240 bytes. */
export function gib(bytes: number): string {
  const n = Math.round((bytes / GIB) * 10) / 10;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** The words a child's line carries: `own filesystem, N GiB` or `shared disk`. */
export function diskWords(disk: ChildDisk): string {
  return disk.own ? `own filesystem, ${gib(disk.bytes)} GiB` : "shared disk";
}

/**
 * Why a child may not start, in one plain line; undefined when it may. Only
 * when the forge requires a filesystem of its own (`children.ownFilesystem`).
 */
export function startRefusal(name: string, disk: ChildDisk, required: boolean): string | undefined {
  if (!required || disk.own) return undefined;
  return `${name} was not started: its data is on the shared disk, not a filesystem of its own, and this forge requires one (children.ownFilesystem is on).`;
}
