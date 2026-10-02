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
 *   bun run src/snapshot/restore.ts <snapshot-name> <data-dir>
 *
 * with the same `S3_*` variables the forge runs under, or
 * `FORGE_SNAPSHOT_DIR` for a directory store.
 *
 * The key comes back only from its wrapped form and the operator's
 * passphrase (`FORGE_SNAPSHOT_PASSPHRASE`). A wrong passphrase refuses the
 * restore; none leaves the key out, and every sealed value that will not
 * open is reported by name.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { runGit } from "../git/env.ts";
import { installHooks } from "../git/hooks.ts";
import { repoDir } from "../git/repos.ts";
import { keyOf, SNAPSHOT_PREFIX, type Manifest } from "./snapshot.ts";
import { unwrapKey, WRAPPED_KEY } from "./wrap.ts";
import { dirStore, s3FromEnv, s3Store, type Store } from "./store.ts";

export interface Restored {
  readonly manifest: Manifest;
  readonly files: number;
  readonly repos: number;
  /** `restored` from the wrapped key, `raw` from an old snapshot, `missing` otherwise. */
  readonly key: "restored" | "raw" | "missing";
  /** Sealed values that will not open without the key, by name. */
  readonly sealedMissing: readonly string[];
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

export async function restoreSnapshot(
  store: Store,
  name: string,
  dataDir: string,
  options: { readonly passphrase?: string | undefined } = {},
): Promise<Restored> {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z$/.test(name))
    throw new Error(`not a snapshot name: ${name}`);
  if (existsSync(dataDir) && readdirSync(dataDir).length > 0)
    throw new Error(
      `${dataDir} is not empty; a restore needs an empty data directory`,
    );
  const prefix = `${SNAPSHOT_PREFIX}${name}/`;
  const raw = await store.get(`${prefix}manifest.json`);
  if (raw === undefined)
    throw new Error(`no snapshot ${name} in ${store.where}`);
  const manifest = JSON.parse(new TextDecoder().decode(raw)) as Manifest;
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
  mkdirSync(dataDir, { recursive: true });

  let files = 0;
  let repos = 0;
  const bundles: { owner: string; name: string; file: string }[] = [];
  for (const entry of manifest.files) {
    const body = await store.get(prefix + entry.path);
    if (body === undefined)
      throw new Error(`snapshot ${name} is missing ${entry.path}`);
    if (body.byteLength !== entry.bytes)
      throw new Error(
        `snapshot ${name}: ${entry.path} is ${body.byteLength} bytes, not ${entry.bytes}`,
      );
    if (entry.path === WRAPPED_KEY) continue;
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
      bundles.push({ owner: bundle[1]!, name: bundle[2]!, file: target });
  }
  for (const b of bundles) {
    const dir = repoDir(join(dataDir, "repos"), b.owner, b.name);
    mkdirSync(dirname(dir), { recursive: true });
    const cloned = await runGit(["clone", "--quiet", "--mirror", b.file, dir]);
    if (!cloned.ok)
      throw new Error(
        `could not restore ${b.owner}/${b.name}: ${cloned.error.stderr}`,
      );
    // A mirror clone remembers the bundle as its origin; the forge's
    // repositories have no origin of their own.
    await runGit(["remote", "remove", "origin"], { cwd: dir });
    await runGit(["config", "core.logAllRefUpdates", "true"], { cwd: dir });
    await installHooks(dir);
    repos++;
  }
  const { rmSync } = await import("node:fs");
  rmSync(join(dataDir, "restore-bundles"), { recursive: true, force: true });
  if (key !== undefined) {
    const target = join(dataDir, "secret.key");
    await Bun.write(target, key);
    chmodSync(target, 0o600);
    files++;
  }
  const kind = keyOf(manifest);
  const have =
    key !== undefined ? "restored" : kind === "raw" ? "raw" : "missing";
  const sealedMissing =
    have === "missing" ? await sealedNames(join(dataDir, "forge.db")) : [];
  return { manifest, files, repos, key: have, sealedMissing };
}

if (import.meta.main) {
  const [name, dataDir] = process.argv.slice(2);
  if (!name || !dataDir) {
    // CLI usage on stderr for the person at the terminal, not a forge event.
    console.error(
      "usage: bun run src/snapshot/restore.ts <snapshot-name> <data-dir>",
    );
    process.exit(2);
  }
  const dir = process.env["FORGE_SNAPSHOT_DIR"]?.trim();
  const s3 = s3FromEnv();
  const store = dir ? dirStore(dir) : s3 ? s3Store(s3) : undefined;
  if (store === undefined) {
    // CLI message on stderr for the person at the terminal.
    console.error(
      "no store: set S3_* as the forge has them, or FORGE_SNAPSHOT_DIR",
    );
    process.exit(2);
  }
  const done = await restoreSnapshot(store, name, dataDir, {
    passphrase: process.env["FORGE_SNAPSHOT_PASSPHRASE"] || undefined,
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
