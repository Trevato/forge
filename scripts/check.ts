/**
 * The gate, run the way the forge runs it.
 *
 * `forge.json`'s `check.run` is the command every push to a pull must pass.
 * A crew member has to be able to see it green before pushing, and the only
 * way that is true is if there is exactly one copy of the command: this
 * reads it from the manifest and hands it to `/bin/sh -c`, which is what
 * `apps/process.ts` does with an app's check on the deploy side.
 *
 * `--record` runs the same string with `scripts/test-shards.ts --record`
 * in place of `scripts/test-shards.ts`, which rewrites
 * `scripts/test-times.json` from this run, so the file list still lives
 * only in `forge.json`.
 */

const manifest = (await Bun.file(
  new URL("../forge.json", import.meta.url),
).json()) as { check?: { run?: string } };

const command = manifest.check?.run;
if (typeof command !== "string" || command.trim() === "") {
  console.error("forge.json declares no check.run");
  process.exit(2);
}

const SHARDS = "scripts/test-shards.ts ";
const record = process.argv.slice(2).includes("--record");
if (record && command.split(SHARDS).length !== 2) {
  console.error("--record: check.run must run scripts/test-shards.ts once");
  process.exit(2);
}
const run = record ? command.replace(SHARDS, `${SHARDS}--record `) : command;

const proc = Bun.spawn(["/bin/sh", "-c", run], {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await proc.exited);
