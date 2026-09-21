/**
 * The gate, run the way the forge runs it.
 *
 * `forge.json`'s `check.run` is the command every push to a pull must pass.
 * A crew member has to be able to see it green before pushing, and the only
 * way that is true is if there is exactly one copy of the command: this
 * reads it from the manifest and hands it to `/bin/sh -c`, which is what
 * `apps/process.ts` does with an app's check on the deploy side.
 */

const manifest = (await Bun.file(
  new URL("../forge.json", import.meta.url),
).json()) as { check?: { run?: string } };

const command = manifest.check?.run;
if (typeof command !== "string" || command.trim() === "") {
  console.error("forge.json declares no check.run");
  process.exit(2);
}

const proc = Bun.spawn(["/bin/sh", "-c", command], {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await proc.exited);
