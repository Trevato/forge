import type { Args } from "../args.ts";
import type { Io } from "../io.ts";
import type { Out } from "../out.ts";

/**
 * One `forge` subcommand. `usage` is its line in `forge help`: the synopsis
 * is painted, `flags` is the plain text after it.
 */
export interface Command {
  name: string;
  usage: { synopsis: string; flags?: string };
  /** `help` prints the usage; it is handed in so commands never import it. */
  run(
    out: Out,
    args: Args,
    help: (out: Out) => void,
    io: Io,
    /** What followed the command name, as typed. */
    argv: readonly string[],
  ): Promise<number>;
}
