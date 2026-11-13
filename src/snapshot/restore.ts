/**
 * A forge back from a snapshot: every file the manifest lists, read into
 * an empty data directory, and every bundle cloned back into a bare
 * repository with the hooks the forge expects. Nothing else — a boot
 * migrates the database forward if the forge has moved on, reconciles the
 * index, and redeploys what runs.
 *
 * It refuses a data directory that is not empty: a restore over a live
 * forge is not a restore, it is a mess.
 *
 *   bun run src/snapshot/restore.ts <snapshot-name|latest> <data-dir> [--clones N]
 *
 * `--clones N` (1–32) sets how many repositories clone at once; the
 * default follows the machine's cores.
 *
 * `latest` is the newest snapshot the store holds, for the person at a
 * fresh machine who does not know the name (`docs/RESTORE.md`).
 *
 * with the same `S3_*` variables the forge runs under, or
 * `FORGE_SNAPSHOT_DIR` for a directory store.
 *
 * A file that went up compressed in parts (the database, `parts.ts`)
 * comes back whole: its parts decompressed as they arrive, in order, into
 * the file, and checked against the size the manifest gives it. No whole
 * compressed copy is held or written.
 *
 * The key comes back only from its wrapped form and the operator's
 * passphrase (`FORGE_SNAPSHOT_PASSPHRASE`). A wrong passphrase refuses the
 * restore; none leaves the key out, and every sealed value that will not
 * open is reported by name.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { runGit } from "../git/env.ts";
import { installHooks } from "../git/hooks.ts";
import { repoDir } from "../git/repos.ts";
import {
  IN_FLIGHT_BYTES,
  isRunBundle,
  keyOf,
  listSnapshots,
  SNAPSHOT_PREFIX,
  unpackRuns,
  type Manifest,
} from "./snapshot.ts";
import { unwrapKey, WRAPPED_KEY } from "./wrap.ts";
import { isPackedFile, partPaths, unpacker, type PackedFile, type Unpacker } from "./parts.ts";
import { resolveDestination } from "./destination.ts";
import { offsiteFromEnv } from "./mirror.ts";
import type { Store } from "./store.ts";

export interface Restored {
  readonly manifest: Manifest;
  readonly files: number;
  readonly repos: number;
  /** `restored` from the wrapped key, `raw` from an old snapshot, `missing` otherwise. */
  readonly key: "restored" | "raw" | "missing";
  /** Sealed values that will not open without the key, by name. */
  readonly sealedMissing: readonly string[];
}

/** Where a restore is, as plain data: `done` of `total` in `phase`, `bytes` so far in it. */
export interface Progress {
  readonly phase: "manifest" | "files" | "unpack" | "bundles" | "key";
  readonly done: number;
  readonly total: number;
  readonly bytes: number;
}

/** Repositories cloned at once unless told otherwise: the machine's cores less one, 2 to 16. */
export const defaultClones = (): number =>
  Math.max(2, Math.min(16, availableParallelism() - 1));

/** The most clones a restore may be asked to run at once. */
export const MAX_CLONES = 32;

/** `--clones` text as a count from 1 to `MAX_CLONES`, or undefined when it is not one. */
export function parseClones(text: string): number | undefined {
  if (!/^[0-9]{1,2}$/.test(text)) return undefined;
  const n = Number(text);
  return n >= 1 && n <= MAX_CLONES ? n : undefined;
}

/** Names of every sealed value in a restored database; never the values. */
async function sealedNames(dbFile: string): Promise<string[]> {
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbFile, { readonly: true });
  try {
    const secrets = db
      .query<{ name: string; scope: string }, []>(
        "SELECT name, scope FROM secret ORDER BY scope, name",
      )
      .all()
      .map((r) => `${r.name} (${r.scope} secret)`);
    const env = db
      .query<{ name: string; slug: string }, []>(
        "SELECT e.name AS name, a.slug AS slug FROM app_env e JOIN app a ON a.id = e.app_id ORDER BY a.slug, e.name",
      )
      .all()
      .map((r) => `${r.name} (app ${r.slug})`);
    return [...secrets, ...env];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * Gets in flight at once on a restore: three times the upload's. The
 * 2026-10-20 drill spent 13 min 35 s of its 16 on download (#3108); reads
 * hold nothing but their own bodies, so more of them may share the memory
 * cap below.
 */
export const RESTORE_IN_FLIGHT = 24;

/**
 * Every file the manifest lists, read with several gets in flight at once
 * and checked against its size, each handed to `each` as it lands. Read
 * one after another, the restore drill of a snapshot with thousands of
 * objects ran out of its ten minutes in the restore step (2026-10-18), as
 * the upload once ran an hour on latency alone; the same limits bound both.
 */
async function fetchAll(
  store: Store,
  prefix: string,
  entries: readonly { readonly path: string; readonly bytes: number }[],
  each: (entry: { readonly path: string; readonly bytes: number }, body: Uint8Array, at: number) => Promise<void>,
  name: string,
  maxBytes: number,
  onFailure: () => void,
): Promise<void> {
  const pending = new Set<Promise<void>>();
  let failure: unknown;
  let held = 0;
  for (const [at, entry] of entries.entries()) {
    while (
      (pending.size >= RESTORE_IN_FLIGHT ||
        (pending.size > 0 && held + entry.bytes > maxBytes)) &&
      failure === undefined
    )
      await Promise.race(pending);
    if (failure !== undefined) break;
    held += entry.bytes;
    const run: Promise<void> = (async () => {
      const body = await store.get(prefix + entry.path);
      if (body === undefined)
        throw new Error(`snapshot ${name} is missing ${entry.path}`);
      if (body.byteLength !== entry.bytes)
        throw new Error(
          `snapshot ${name}: ${entry.path} is ${body.byteLength} bytes, not ${entry.bytes}`,
        );
      await each(entry, body, at);
    })()
      .catch((error: unknown) => {
        failure ??= error;
        // Parts held for an earlier one would wait for ever.
        onFailure();
      })
      .finally(() => {
        held -= entry.bytes;
        pending.delete(run);
      });
    pending.add(run);
  }
  await Promise.all([...pending]);
  if (failure !== undefined) throw failure;
}

export async function restoreSnapshot(
  store: Store,
  name: string,
  dataDir: string,
  options: {
    readonly passphrase?: string | undefined;
    /** Bytes held by reads in flight; `IN_FLIGHT_BYTES` unless a test shrinks it. */
    readonly inFlightBytes?: number | undefined;
    /** Test seam: the git runner the clones go through. */
    readonly git?: typeof runGit | undefined;
    /** Repositories cloned at once; `defaultClones()` when unset. */
    readonly clones?: number | undefined;
    /** Told when each phase starts and after each file or bundle finishes. */
    readonly onProgress?: ((p: Progress) => void) | undefined;
  } = {},
): Promise<Restored> {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z$/.test(name))
    throw new Error(`not a snapshot name: ${name}`);
  if (existsSync(dataDir) && readdirSync(dataDir).length > 0)
    throw new Error(
      `${dataDir} is not empty; a restore needs an empty data directory`,
    );
  const say = (phase: Progress["phase"], done: number, total: number, bytes: number): void =>
    options.onProgress?.({ phase, done, total, bytes });
  const prefix = `${SNAPSHOT_PREFIX}${name}/`;
  say("manifest", 0, 1, 0);
  const raw = await store.get(`${prefix}manifest.json`);
  if (raw === undefined)
    throw new Error(`no snapshot ${name} in ${store.where}`);
  const manifest = JSON.parse(new TextDecoder().decode(raw)) as Manifest;
  say("manifest", 1, 1, raw.byteLength);
  const wrapped = manifest.files.some((f) => f.path === WRAPPED_KEY)
    ? await store.get(prefix + WRAPPED_KEY)
    : undefined;
  let key: Buffer | undefined;
  if (wrapped !== undefined && options.passphrase) {
    key = unwrapKey(wrapped, options.passphrase);
    // Better to stop here than to restore a forge that silently cannot
    // open its values because of a mistyped passphrase.
    if (key === undefined)
      throw new Error(
        "the passphrase does not open this snapshot's wrapped key; check FORGE_SNAPSHOT_PASSPHRASE, or restore without it to leave sealed values behind",
      );
  }
  const packed: readonly unknown[] = manifest.packed ?? [];
  if (!packed.every(isPackedFile))
    throw new Error(`snapshot ${name}: a packed file in its manifest does not read whole`);
  // A part the manifest does not list is refused before anything is written.
  const listed = new Set(manifest.files.map((f) => f.path));
  for (const file of packed)
    for (const path of partPaths(file))
      if (!listed.has(path)) throw new Error(`snapshot ${name} is missing ${path}`);
  // Each packed file unpacks as its parts arrive, in order, to disk.
  mkdirSync(dataDir, { recursive: true });
  const unpackers: { file: PackedFile; unpacker: Unpacker }[] = [];
  const partOf = new Map<string, { file: PackedFile; unpacker: Unpacker; n: number }>();
  for (const file of packed) {
    const target = join(dataDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    const made = unpacker(file, target);
    unpackers.push({ file, unpacker: made });
    for (const [n, path] of partPaths(file).entries())
      partOf.set(path, { file, unpacker: made, n });
  }
  const abandon = (): void => {
    for (const u of unpackers) u.unpacker.abort();
  };
  // A part waits in memory for the parts before it, so the parts are read
  // in part order: a manifest that lists them otherwise cannot stall the reads.
  const order = [...manifest.files];
  const slots = order.flatMap((f, i) => (partOf.has(f.path) ? [i] : []));
  const inPartOrder = slots
    .map((i) => order[i])
    .sort((x, y) => {
      const px = partOf.get(x?.path ?? "");
      const py = partOf.get(y?.path ?? "");
      if (px === undefined || py === undefined) return 0;
      return px.file.path === py.file.path ? px.n - py.n : px.file.path < py.file.path ? -1 : 1;
    });
  for (const [k, i] of slots.entries()) {
    const entry = inPartOrder[k];
    if (entry !== undefined) order[i] = entry;
  }

  let files = 0;
  let repos = 0;
  const bundles: { at: number; owner: string; name: string; file: string }[] = [];
  let fetched = 0;
  let fetchedBytes = 0;
  say("files", 0, manifest.files.length, 0);
  try {
    await fetchAll(store, prefix, order, async (entry, body, at) => {
      fetched++;
      fetchedBytes += entry.bytes;
      say("files", fetched, manifest.files.length, fetchedBytes);
      if (entry.path === WRAPPED_KEY) return;
      // A part goes into its file's decompression as soon as its turn comes.
      const part = partOf.get(entry.path);
      if (part !== undefined) {
        await part.unpacker.feed(part.n, body);
        return;
      }
      // A day's run logs in one object come back as the logs they were.
      if (isRunBundle(entry.path)) {
        for (const run of unpackRuns(body)) {
          const out = join(dataDir, "runs", run.path);
          mkdirSync(dirname(out), { recursive: true });
          await Bun.write(out, run.body);
          files++;
        }
        return;
      }
      const bundle = entry.path.match(/^repos\/([^/]+)\/([^/]+)\.bundle$/);
      // A bundle is not a file of the forge's; it becomes a repository below.
      const target = bundle
        ? join(dataDir, "restore-bundles", `${bundle[1]}--${bundle[2]}.bundle`)
        : join(dataDir, entry.path);
      mkdirSync(dirname(target), { recursive: true });
      await Bun.write(target, body);
      // A key the rest of the machine could read is one the forge refuses to
      // use; the snapshot carries bytes, not modes, so the modes are set here.
      if (entry.path === "secret.key" || entry.path.startsWith("ssh/"))
        chmodSync(target, 0o600);
      files++;
      if (bundle)
        bundles.push({ at, owner: bundle[1]!, name: bundle[2]!, file: target });
    }, name, options.inFlightBytes ?? IN_FLIGHT_BYTES, abandon);
  } catch (error) {
    abandon();
    throw error;
  }
  // Reads land in any order; repositories come back in the manifest's.
  bundles.sort((a, b) => a.at - b.at);
  let unpacked = 0;
  let unpackedBytes = 0;
  say("unpack", 0, packed.length, 0);
  for (const { unpacker: u } of unpackers) {
    let whole: number;
    try {
      whole = await u.finish();
    } catch (error) {
      abandon();
      throw error;
    }
    files++;
    unpacked++;
    unpackedBytes += whole;
    say("unpack", unpacked, packed.length, unpackedBytes);
  }
  // Each repository is its own clone, so several at once: a forge of
  // hundreds of them spent the drill's minutes here, one after another.
  const git = options.git ?? runGit;
  let next = 0;
  let cloned = 0;
  let clonedBytes = 0;
  const sizes = new Map(manifest.files.map((f) => [f.path, f.bytes]));
  say("bundles", 0, bundles.length, 0);
  // Clones finish in any order; a refusal names the earliest bundle in the
  // manifest that failed, so it reads the same however the clones raced.
  const failed: { at: number; error: string }[] = [];
  await Promise.all(
    Array.from({ length: Math.min(options.clones ?? defaultClones(), bundles.length) }, async () => {
      for (let b = bundles[next++]; b !== undefined; b = bundles[next++]) {
        const dir = repoDir(join(dataDir, "repos"), b.owner, b.name);
        mkdirSync(dirname(dir), { recursive: true });
        const result = await git([
          "clone",
          "--quiet",
          "--mirror",
          b.file,
          dir,
        ]);
        if (!result.ok) {
          next = bundles.length;
          failed.push({
            at: b.at,
            error: `could not restore ${b.owner}/${b.name}: ${result.error.stderr}`,
          });
          return;
        }
        // A mirror clone remembers the bundle as its origin; the forge's
        // repositories have no origin of their own.
        await git(["remote", "remove", "origin"], { cwd: dir });
        await git(["config", "core.logAllRefUpdates", "true"], { cwd: dir });
        await installHooks(dir);
        repos++;
        cloned++;
        clonedBytes += sizes.get(`repos/${b.owner}/${b.name}.bundle`) ?? 0;
        say("bundles", cloned, bundles.length, clonedBytes);
      }
    }),
  );
  if (failed.length > 0)
    throw new Error(failed.sort((a, b) => a.at - b.at)[0]!.error);
  const { rmSync } = await import("node:fs");
  rmSync(join(dataDir, "restore-bundles"), { recursive: true, force: true });
  say("key", 0, key === undefined ? 0 : 1, 0);
  if (key !== undefined) {
    const target = join(dataDir, "secret.key");
    await Bun.write(target, key);
    chmodSync(target, 0o600);
    files++;
    say("key", 1, 1, key.byteLength);
  }
  const kind = keyOf(manifest);
  const have =
    key !== undefined ? "restored" : kind === "raw" ? "raw" : "missing";
  const sealedMissing =
    have === "missing" ? await sealedNames(join(dataDir, "forge.db")) : [];
  return { manifest, files, repos, key: have, sealedMissing };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let clones: number | undefined;
  const at = args.indexOf("--clones");
  if (at >= 0) {
    clones = parseClones(args[at + 1] ?? "");
    if (clones === undefined) {
      // CLI message on stderr for the person at the terminal.
      console.error(`--clones takes a whole number from 1 to ${MAX_CLONES}`);
      process.exit(2);
    }
    args.splice(at, 2);
  }
  // `--offsite`: read the sealed off-site lane (FORGE_MIRROR_S3_*) in place of the destination (#11805).
  const offsite = args.indexOf("--offsite");
  if (offsite >= 0) args.splice(offsite, 1);
  const [name, dataDir] = args;
  if (!name || !dataDir || args.length > 2) {
    // CLI usage on stderr for the person at the terminal, not a forge event.
    console.error(
      "usage: bun run src/snapshot/restore.ts <snapshot-name|latest> <data-dir> [--clones N] [--offsite]",
    );
    process.exit(2);
  }
  // A restore starts from an empty directory, so nothing is sealed yet: the
  // same resolver answers from the environment alone.
  const lane = offsite >= 0 ? offsiteFromEnv() : undefined;
  if (typeof lane === "string") {
    // CLI message on stderr for the person at the terminal.
    console.error(lane);
    process.exit(2);
  }
  const store = lane ?? resolveDestination()?.store;
  if (store === undefined) {
    // CLI message on stderr for the person at the terminal.
    console.error(
      "no store: set S3_* as the forge has them, or FORGE_SNAPSHOT_DIR",
    );
    process.exit(2);
  }
  const newest = name === "latest" ? (await listSnapshots(store))[0] : undefined;
  if (name === "latest" && newest === undefined) {
    // CLI message on stderr for the person at the terminal.
    console.error(`no snapshot in ${store.where}`);
    process.exit(1);
  }
  // One line per phase when it ends: its count, bytes and seconds.
  let began = performance.now();
  const done = await restoreSnapshot(store, newest?.name ?? name, dataDir, {
    passphrase: process.env["FORGE_SNAPSHOT_PASSPHRASE"] || undefined,
    clones,
    onProgress: (p) => {
      if (p.done < p.total) return;
      const seconds = ((performance.now() - began) / 1000).toFixed(1);
      console.log(`${p.phase}: ${p.done}/${p.total}, ${p.bytes} bytes, ${seconds}s`);
      began = performance.now();
    },
  });
  console.log(
    `restored ${done.manifest.name} (forge ${done.manifest.version}): ${done.files} files, ${done.repos} repositories into ${dataDir}`,
  );
  if (done.key === "missing") {
    console.log(
      `the key was not restored: ${done.sealedMissing.length} sealed value(s) will not open and must be set again:`,
    );
    for (const n of done.sealedMissing) console.log(`  ${n}`);
  }
}
