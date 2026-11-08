/**
 * `bun scripts/cut-release.ts <version> [--tag]`: the release record for
 * the commit checked out — its version, how many migrations it applies and
 * the stamped ones by name — printed as the JSON `release/shipped.ts`
 * reads. With `--tag` it also makes the annotated tag `v<version>` on HEAD
 * with that record as its message; pushing the tag (`git push origin
 * v<version>`) is the release. Nothing is committed: a release cut never
 * moves main, so it voids no gate in flight (#6640). It ends by printing, on
 * stderr, the load check to run before the tag is pushed (`release-load.ts`, #9504).
 */

import { migrationFiles, NUMBERED } from "../src/core/schema.ts";
import { loadCheckHint } from "../src/perf/baseline.ts";
import { compareVersions, mergeShipped, readTagged, recordFor, shippedReleases } from "../src/release/shipped.ts";

const VERSION = /^\d+\.\d+\.\d+$/;
const [version, flag] = process.argv.slice(2);
if (version === undefined || !VERSION.test(version) || (flag !== undefined && flag !== "--tag")) {
  console.error("usage: bun scripts/cut-release.ts <major.minor.patch> [--tag]");
  process.exit(2);
}
const root = `${import.meta.dir}/..`;
const newest = mergeShipped(shippedReleases(), await readTagged(root))[0];
if (newest !== undefined && compareVersions(version, newest.version) >= 0) {
  console.error(`cut-release: ${version} is not newer than ${newest.version}, the newest release`);
  process.exit(1);
}
const record = JSON.stringify(recordFor(version, migrationFiles, NUMBERED));
if (flag === "--tag") {
  const made = Bun.spawnSync(["git", "tag", "--annotate", "--file=-", `v${version}`, "HEAD"], {
    cwd: root,
    stdin: new Blob([`${record}\n`]),
    stderr: "pipe",
  });
  if (made.exitCode !== 0) {
    console.error(`cut-release: ${made.stderr.toString().trim()}`);
    process.exit(1);
  }
}
// CLI answer for the person at the terminal.
console.log(record);
console.error(loadCheckHint(version));
