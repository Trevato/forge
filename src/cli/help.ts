import { configPath, rootDir } from "./config.ts";
import { commands } from "./commands/index.ts";
import type { Out } from "./out.ts";

/**
 * The CLI's own number, kept by hand: it ships compiled, to machines no
 * release stamps. The server's comes from its build (`kernel/version.ts`).
 */
export const VERSION = "0.0.1";

/** Where the flags column starts, so every command's notes line up. */
const FLAGS_COLUMN = 31;

/** `forge help`: one line per command, in the table's order. */
export function printUsage(out: Out): void {
  const b = (text: string): string => out.paint(text, out.c.fg);
  out.line(`forge ${VERSION} — your workbench, on this machine`);
  out.line();
  for (const { usage } of commands) {
    const head = `  ${usage.synopsis}`;
    out.line(
      usage.flags === undefined
        ? b(head)
        : b(head) +
            " ".repeat(Math.max(1, FLAGS_COLUMN - head.length)) +
            usage.flags,
    );
  }
  out.line();
  out.line(
    out.paint(`  config ${configPath()}   root ${rootDir()}`, out.c.faint),
  );
  out.line(
    out.paint(
      "  FORGE_URL, FORGE_TOKEN, FORGE_ROOT and NO_COLOR are honoured.",
      out.c.faint,
    ),
  );
}
