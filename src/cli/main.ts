#!/usr/bin/env bun
/**
 * `forge` — the client that lives on your machine.
 *
 *   forge                     the local terminal UI over your clones
 *   forge login <url>         remember a workbench and a token
 *   forge sync                clone what is missing, fetch the rest, report
 *   forge status              the same report without touching the network
 *   forge asks                what waits on you, most important first
 *   forge tell "words"        tell the crew about this folder's repository
 *   forge search <words>      code, issues, pulls and repos you can read
 *   forge asks --ship 1 3     decide asks by their numbers: planned, then a y/N
 *   forge asks --undo <id>    take back what that decided
 *   forge new <name> [words]  make an app and clone it into your forge folder
 *   forge map                 the plan: being built, ready now, what waits
 *   forge ship <number>       land a pull after a y/N, as its Merge button does
 *
 * Everything here is a thin shell around three modules: `api.ts` talks to the
 * workbench, `sync.ts` decides what should be on disk, `report.ts` prints it.
 * This file's whole job is to turn argv into one of those calls and to pick
 * an exit code — so a script can branch on the result without parsing text.
 */

import { parseArgs } from "./args.ts";
import { commands } from "./commands/index.ts";
import { EXIT } from "./exit.ts";
import { printUsage, VERSION } from "./help.ts";
import { askLine, type Io } from "./io.ts";
import { createOut } from "./out.ts";

// Callers (and tests) have always reached these through this file.
export { asks, askLines, type Confirm } from "./commands/asks.ts";
export { searchLines, narrowConversations, type SearchFor } from "./commands/search.ts";
export { EXIT };

/** Every command by name, built once from `commands/index.ts`. */
const TABLE = new Map(commands.map((c) => [c.name, c]));

const VALUE_FLAGS = ["token", "interval", "root", "url", "limit", "repo", "kind", "reason", "owner", "variants", "from", "table", "file", "page"];

export async function main(
  argv: readonly string[],
  io: Io = { ask: askLine },
): Promise<number> {
  const args = parseArgs(argv, { values: VALUE_FLAGS });
  const out = createOut();

  if (args.flag("version") || args.flag("v")) {
    out.line(`forge ${VERSION}`);
    return EXIT.ok;
  }
  if (args.flag("help") || args.flag("h") || args.command === "help") {
    printUsage(out);
    return EXIT.ok;
  }

  // No command is the terminal UI.
  const command = TABLE.get(args.command ?? "ui");
  if (command === undefined) {
    out.err(`forge: unknown command "${args.command}"`);
    printUsage(out);
    return EXIT.usage;
  }
  return command.run(out, args, printUsage, io, argv.slice(1));
}

// `import.meta.main` is false when a test imports `main` directly, which is
// exactly the boundary we want: the tests drive the same function the shell
// does, and nothing here calls `process.exit` behind their back.
if (import.meta.main) process.exit(await main(process.argv.slice(2)));
