/**
 * The dedicated hook entry point, used when the forge runs from source
 * (`bun run`, `bun test`, or embedded). It self-dispatches regardless of
 * what launched the host process — the git hook stub execs it directly, so
 * it never depends on the forge being the process entrypoint. Compiled
 * binaries take the `hook` subcommand in main.ts instead.
 */

import { isHookName, runHookClient } from "./hooks.ts";

const name = process.argv[process.argv.length - 1];
if (!isHookName(name)) {
  console.error(`forge: unknown hook ${name}`);
  process.exit(1);
}
await runHookClient(name);
