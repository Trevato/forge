/**
 * Runtime state the tree must not carry (#622): a private key or a SQLite
 * database committed beside the source rides into every clone and preview.
 *
 * `auditTree` names each such file, one line per file, outside `FIXTURES`
 * (the explicit allow-list for test fixtures). `test/tree.test.ts` runs it
 * over the tracked files, so the gate goes red on one. In a clone the files
 * are `git ls-files`; in the forge's check directory, written by
 * `checkout-index` with no `.git`, every file there is a tracked one, so the
 * directory is walked instead (`node_modules` aside, which the install made).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Tracked files allowed to look like a key or a database, each with its reason. */
export const FIXTURES: readonly { file: string; reason: string }[] = [];

/** The 16-byte header every SQLite 3 database file starts with. */
const SQLITE = new TextEncoder().encode("SQLite format 3\0");
// Spelled so this source does not match itself.
const PRIVATE_KEY = new RegExp(`-{5}BEGIN [A-Z0-9 ]*PRIVATE KEY-{5}`);

/** What `bytes` look like, if it is something the tree refuses. */
export function stateKind(bytes: Uint8Array): string | null {
  if (
    bytes.length >= SQLITE.length &&
    SQLITE.every((byte, i) => bytes[i] === byte)
  )
    return "a SQLite database";
  // latin1 keeps every byte one character, so a key inside a binary still shows.
  if (PRIVATE_KEY.test(Buffer.from(bytes).toString("latin1")))
    return "a private key";
  return null;
}

/** One line per tracked file that is a key or a database and not a listed fixture. */
export function auditTree(
  files: readonly string[],
  read: (file: string) => Uint8Array,
  fixtures: readonly { file: string }[] = FIXTURES,
): string[] {
  const allowed = new Set(fixtures.map((f) => f.file));
  const problems: string[] = [];
  for (const file of files) {
    if (allowed.has(file)) continue;
    const kind = stateKind(read(file));
    if (kind !== null)
      problems.push(
        `${file} is ${kind}; runtime state belongs under FORGE_DATA, a fixture belongs in FIXTURES (scripts/tree.ts)`,
      );
  }
  return problems;
}

function walk(root: string, dir = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      out.push(...walk(root, path));
    } else if (entry.isFile()) out.push(path);
  }
  return out;
}

/** The repository's tracked files, relative to `root`. */
export function trackedFiles(root: string): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: root,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (listed.exitCode === 0)
    return listed.stdout
      .toString()
      .split("\0")
      .filter((file) => file !== "");
  return walk(root);
}

/** The tree's problems, read from disk; a tracked file deleted in the work tree is skipped. */
export function auditRepository(root: string): string[] {
  return auditTree(trackedFiles(root), (file) => {
    try {
      return readFileSync(join(root, file));
    } catch {
      return new Uint8Array();
    }
  });
}
