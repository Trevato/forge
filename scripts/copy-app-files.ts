/**
 * Copy an app's files and uploads into its FORGE_APP_DATA and prove it:
 *
 *   bun scripts/copy-app-files.ts [--allow-skips] <source-dir> [target-dir]   # target defaults to $FORGE_APP_DATA
 *   bun scripts/copy-app-files.ts --manifest <dir>                            # print a manifest, e.g. on the old node
 *
 * Exit 0: the manifests at both ends match and nothing was left behind.
 * Exit 1: they differ, or symlinks/devices were skipped (unless --allow-skips).
 * Exit 2: usage or an unreadable path. Prints counts and the target's
 * manifest, ready to paste into the migration issue.
 * See docs/features/platform-app-move.md.
 */

import { buildManifest, copyWithManifest, manifestText } from "../src/apps/file_manifest.ts";

const argv = process.argv.slice(2);
const allowSkips = argv.includes("--allow-skips");
const args = argv.filter((a) => a !== "--allow-skips");
try {
  if (args[0] === "--manifest" && args[1]) {
    const m = buildManifest(args[1]);
    process.stdout.write(manifestText(m));
    for (const s of m.skipped) console.error(`skipped (not a regular file): ${s}`);
    process.exit(0);
  }
  const from = args[0];
  const to = args[1] ?? process.env.FORGE_APP_DATA;
  if (!from || !to) {
    console.error("usage: bun scripts/copy-app-files.ts [--allow-skips] <source-dir> [target-dir]  (target defaults to $FORGE_APP_DATA)");
    process.exit(2);
  }
  const r = copyWithManifest(from, to, { allowSkips });
  console.log(`copied ${r.files} files, ${r.bytes} bytes`);
  for (const s of r.skipped) console.log(`SKIPPED (not a regular file, not copied): ${s}`);
  for (const p of r.diff.missing) console.log(`MISSING ${p}`);
  for (const p of r.diff.changed) console.log(`CHANGED ${p}`);
  for (const p of r.diff.extra) console.log(`EXTRA ${p} (already in the target, not in the source)`);
  console.log(r.ok ? "manifests match" : "NOT PROVEN: manifests differ or files were left behind");
  if (r.ok) process.stdout.write(manifestText(r.target));
  process.exit(r.ok ? 0 : 1);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}
