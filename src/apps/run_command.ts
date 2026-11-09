/**
 * How a manifest's `run` (or `tty`) becomes a shell command. A simple
 * command is `exec`ed, so the app replaces the shell and signals reach it
 * directly. A compound one (`cd sub && bun server.ts`) is run as written:
 * `exec cd sub && …` would exec `cd`, which is no program. The whole tree
 * is still stopped — by process group, or by the cell's tree walk.
 */

/** Whether the command uses a shell operator, a subshell, or spans lines. */
export function isCompound(run: string): boolean {
  return /&&|\|\||[;|&\n()`]|\$\(/.test(run);
}

/** The shell text to spawn for a manifest command. */
export function shellCommand(run: string): string {
  return isCompound(run) ? run : `exec ${run}`;
}

const NOT_FOUND_RE = /exec: ([^\s:]+): not found/;

/** When the shell says `exec: X: not found`, the fix, else undefined. */
export function notFoundHint(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const found = NOT_FOUND_RE.exec(line);
    if (found === null) continue;
    const word = found[1] ?? "";
    return ["cd", "export", "source", ".", "set", "umask"].includes(word)
      ? `"${word}" is a shell builtin, not a program: chain it with a program, as in "cd sub && bun server.ts"`
      : `"${word}" is not installed or not on PATH: name an installed program in forge.json "run"`;
  }
  return undefined;
}
